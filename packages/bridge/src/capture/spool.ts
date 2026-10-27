/**
 * The review inbox's intake: the capture hook (skills/once-upon/bin/capture-turn.sh) snapshots the working tree at each
 * prompt and Stop and appends one line about it to a spool, and the bridge reads the spool and makes the turns. Nothing
 * goes over HTTP, and nothing is lost while the bridge is down: the lines wait.
 *
 *   <home>/turns/incoming.jsonl   one JSON object a line, owner-only, appended by the hook:
 *     {"v":1,"event":"prompt"|"stop","session":"…","top":"/path/to/checkout","tree":"<git tree id>","branch":"main",
 *      "at":"2026-10-27T15:25:23Z","transcript":"/path/to/<session>.jsonl"}
 *   <home>/turn-spool.json        where the reader is: its byte offset, the prompts still waiting for their Stop, each
 *                                 session's last Stop tree, and a spool file being retired (rotation)
 *
 * A turn is what changed between a prompt's snapshot and the Stop's. Per session and checkout:
 *   prompt, nothing open        remember it
 *   prompt, one already open    the open one was stopped (Esc): a turn from its tree to this prompt's, `interrupted`
 *   stop, one open              a turn from the prompt's tree to the stop's
 *   stop, none open             the session began without the prompt hook: a turn from the last Stop's tree, when there is one
 * The prompt and Claude's last message come from the transcript (transcript.ts), not from the line.
 *
 * Reading is idempotent. A turn's id comes from the two records (turnIdOf), and a turn already kept is skipped, so
 * lines read again after a crash, a restart or a lost offset make no duplicates and don't undo a "reviewed" mark.
 * A line no one can use (bad JSON, a tree id that isn't one, a checkout that isn't) is logged and skipped.
 *
 * The snapshots are unreferenced git objects, which `git gc` removes after about 2 weeks. A bridge that was down that
 * long skips the pairs whose trees are gone, with a line in the log.
 *
 * Rotation: once every line is read and the file is over `rotateBytes`, it is renamed to incoming.<time>.old (a hook
 * that had it open still appends to that file, and one that comes later makes a new incoming.jsonl). The old file is read
 * once more and deleted after `rotateGraceMs`, so an append that raced the rename isn't lost. Its held Stop (one that
 * waits for the transcript) holds the main spool back too, so records are paired in the order they were written.
 *
 * Pairing is stateful, so a file read again from its start is not read with the state its end left. A spool that shrank
 * (emptied or replaced) starts the pairing over, and an `.old` file found with no place saved for it (the bridge stopped
 * between the rename and saving) is read on its own, with empty state, to catch what was never made into a turn.
 *
 * Only one reader runs per home: <home>/turn-spool.lock holds its pid, and a second bridge on the same home logs that
 * and stays off (two readers would each rotate and overwrite the other's place).
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { ownerOnly, readSettings } from '../config/settings.ts';
import { repoOfCheckout } from '../config/repos.ts';
import { readJson } from '../util/json-file.ts';
import { pidAlive } from '../util/pid.ts';
import { Transcript, PROMPT_LEAD_MS, textOfTurn } from './transcript.ts';
import { MissingTreesError, SESSION_RE, TREE_RE, turnIdOf } from './turns.ts';
import type { TurnStore } from './turns.ts';
import type { Turn } from '@once-upon-a-diff/shared/types';

export const SPOOL_NAME = 'incoming.jsonl';
const STATE_NAME = 'turn-spool.json';
const MAX_LINE = 8192;
const CHUNK = 4 * 1024 * 1024;
const LOCK_NAME = 'turn-spool.lock';
/** How far a record's time may be ahead of the clock and still be waited for (a Stop is held settleMs after its time). */
const CLOCK_SKEW_MS = 5000;
/** Prompts and Stops older than this are forgotten: their trees are most likely gone by then. */
const FORGET_MS = 14 * 24 * 3600 * 1000;

export const spoolFile = (home: string) => path.join(home, 'turns', SPOOL_NAME);
const stateFile = (home: string) => path.join(home, STATE_NAME);
const lockFile = (home: string) => path.join(home, LOCK_NAME);
/** Locks this process holds, for a second reader in the same process (the pid is the same). */
const heldLocks = new Set<string>();

/** One line of the spool. */
export interface SpoolRecord {
  v: 1;
  event: 'prompt' | 'stop';
  session: string;
  top: string;
  tree: string;
  branch: string | null;
  at: string;
  transcript: string;
}

/** The record, or why the line can't be used. */
export function parseRecord(line: string): { record: SpoolRecord } | { error: string } {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: 'not JSON' };
  }
  if (!value || typeof value !== 'object' || value.v !== 1) {
    return { error: 'not a version 1 record' };
  }
  const { event, session, top, tree, branch, at, transcript } = value;
  if (event !== 'prompt' && event !== 'stop') {
    return { error: `unknown event ${JSON.stringify(event)}` };
  }
  if (typeof session !== 'string' || !SESSION_RE.test(session)) {
    return { error: 'bad session id' };
  }
  if (typeof top !== 'string' || !path.isAbsolute(top) || top.length > 1024) {
    return { error: 'the checkout is not an absolute path' };
  }
  if (typeof tree !== 'string' || !TREE_RE.test(tree)) {
    return { error: 'the tree is not a full object id' };
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return { error: 'bad time' };
  }
  return {
    record: {
      v: 1,
      event,
      session,
      top,
      tree,
      branch: typeof branch === 'string' && branch ? branch.slice(0, 200) : null,
      at,
      transcript: typeof transcript === 'string' ? transcript : '',
    },
  };
}

/** A prompt waiting for its Stop. */
interface OpenPrompt {
  tree: string;
  at: string;
  branch: string | null;
  transcript: string;
}

/** The reader's place, kept in turn-spool.json. */
export interface SpoolState {
  /** the next byte of incoming.jsonl to read */
  offset: number;
  /** by `<session>\n<checkout>` */
  open: Record<string, OpenPrompt>;
  last: Record<string, { tree: string; at: string }>;
  /**
   * an incoming file retired by rotation, still being read for a late append. `replay`: it was found with no place saved
   * for it, so it is read from its start with empty pairing state, and its pairs keep no state.
   */
  rotated: { name: string; offset: number; at: number; replay?: boolean } | null;
}

export const emptyState = (): SpoolState => ({ offset: 0, open: {}, last: {}, rotated: null });

/** Two spool records that make a turn. */
export interface Pair {
  session: string;
  top: string;
  base_tree: string;
  head_tree: string;
  /** the time of the first record (a prompt's, or the last Stop's) and of the last */
  started_at: string;
  at: string;
  branch: string | null;
  transcript: string;
  interrupted: boolean;
  /** the first record is the turn's own prompt (false: it is the session's previous Stop) */
  from_prompt: boolean;
}

/** Takes one record into the state, and returns the turn it completes, if any (null when its trees match). */
export function pairRecord(state: SpoolState, rec: SpoolRecord): Pair | null {
  const key = `${rec.session}\n${rec.top}`;
  const open = state.open[key];
  if (rec.event === 'prompt') {
    state.open[key] = {
      tree: rec.tree,
      at: rec.at,
      branch: rec.branch,
      transcript: rec.transcript,
    };
    // another prompt with no Stop between: the open one was stopped, and it ends at this snapshot
    return open && open.tree !== rec.tree
      ? {
          session: rec.session,
          top: rec.top,
          base_tree: open.tree,
          head_tree: rec.tree,
          started_at: open.at,
          at: rec.at,
          branch: open.branch,
          transcript: rec.transcript || open.transcript,
          interrupted: true,
          from_prompt: true,
        }
      : null;
  }
  const start = open || state.last[key];
  delete state.open[key];
  state.last[key] = { tree: rec.tree, at: rec.at };
  if (!start || start.tree === rec.tree) {
    return null;
  }
  return {
    session: rec.session,
    top: rec.top,
    base_tree: start.tree,
    head_tree: rec.tree,
    started_at: start.at,
    at: rec.at,
    branch: rec.branch,
    transcript: rec.transcript || (open ? open.transcript : ''),
    interrupted: false,
    from_prompt: !!open,
  };
}

const realpathOr = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * Whether config.json's capture_exclude names this checkout: an `owner/name` (any case) matched against its origin, or a
 * folder (absolute, already ~-expanded) that is the checkout. The hook applies the same rule before it snapshots.
 */
export function isExcluded(exclude: string[], top: string): boolean {
  if (!exclude.length) {
    return false;
  }
  const real = realpathOr(top);
  const slug = repoOfCheckout(top)?.toLowerCase();
  return exclude.some((entry) =>
    path.isAbsolute(entry)
      ? entry === top || realpathOr(entry) === real
      : !!slug && entry.toLowerCase() === slug,
  );
}

/** A file written through a temp file and a rename, for the user alone. */
function writePrivate(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

/** What one pass shares between the lines it reads. */
interface ReadContext {
  exclude: string[];
  transcripts: Map<string, Transcript | null>;
  /** the pairing state these lines go through */
  state: SpoolState;
}

export interface SpoolOptions {
  /** how long a Stop waits before it is read, for the transcript to be flushed (default 2000) */
  settleMs?: number;
  /** how often the file is looked at when fs.watch says nothing (default 5000) */
  pollMs?: number;
  /** how soon after a change the file is read (default 300) */
  debounceMs?: number;
  /** a fully read file this big is rotated (default 5 MB) */
  rotateBytes?: number;
  /** how long a retired file is kept for a late append (default 2000) */
  rotateGraceMs?: number;
  now?: () => number;
}

export class TurnSpool {
  declare home: string;
  declare turns: TurnStore;
  declare log: (line: string) => void;
  declare onTurn: (turn: Turn) => void;
  declare opts: Required<SpoolOptions>;
  declare state: SpoolState;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private watcher: FSWatcher | null = null;
  private timers: NodeJS.Timeout[] = [];
  private kickTimer: NodeJS.Timeout | null = null;
  private heldUntil = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  /** another bridge on this home reads the spool, so this one doesn't */
  private off = false;
  private locked = false;

  constructor(
    home: string,
    turns: TurnStore,
    log: (line: string) => void,
    onTurn: (turn: Turn) => void = () => {},
    opts: SpoolOptions = {},
  ) {
    this.home = home;
    this.turns = turns;
    this.log = log;
    this.onTurn = onTurn;
    this.opts = {
      settleMs: 2000,
      pollMs: 5000,
      debounceMs: 300,
      rotateBytes: 5 * 1024 * 1024,
      rotateGraceMs: 2000,
      now: Date.now,
      ...opts,
    };
    this.state = this.load();
  }

  private load(): SpoolState {
    const saved = readJson<Partial<SpoolState>>(stateFile(this.home), {}) || {};
    const state = emptyState();
    state.offset =
      Number.isInteger(saved.offset) && (saved.offset as number) > 0 ? (saved.offset as number) : 0;
    const cutoff = this.opts.now() - FORGET_MS;
    for (const [key, open] of Object.entries(saved.open || {})) {
      if (open && Date.parse(open.at) > cutoff) {
        state.open[key] = open;
      }
    }
    for (const [key, last] of Object.entries(saved.last || {})) {
      if (last && Date.parse(last.at) > cutoff) {
        state.last[key] = last;
      }
    }
    if (saved.rotated && /^incoming\.[0-9]+\.old$/.test(saved.rotated.name)) {
      state.rotated = saved.rotated;
    }
    return state;
  }

  private save(): void {
    writePrivate(
      stateFile(this.home),
      JSON.stringify({ ...this.state, saved_at: new Date(this.opts.now()).toISOString() }),
    );
  }

  /** Starts reading: once now, when the spool changes (fs.watch) and every pollMs, which covers a missed event. */
  start(): void {
    const dir = path.dirname(spoolFile(this.home));
    ownerOnly(dir);
    const other = this.lock();
    if (other !== null) {
      this.off = true;
      this.log(
        `turn spool: ${other ? `the bridge with pid ${other}` : 'another bridge'} already reads this home's spool, so this one leaves it alone`,
      );
      return;
    }
    // the older hook's per-session baselines are dead weight now
    rmSync(path.join(this.home, 'turn-baselines'), { recursive: true, force: true });
    try {
      this.watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (!name || name.startsWith('incoming.')) {
          this.kick();
        }
      });
      this.watcher.on('error', () => {});
    } catch {
      this.watcher = null; // the poll still finds new lines
    }
    this.timers.push(setInterval(() => this.kick(), this.opts.pollMs).unref());
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.unlock();
    this.watcher?.close();
    this.watcher = null;
    for (const timer of [...this.timers, this.kickTimer, this.holdTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.timers = [];
  }

  /** Takes the reader's lock: null when it is ours now, else the pid of the bridge that has it (0 when unknown). */
  private lock(): number | null {
    const file = lockFile(this.home);
    if (heldLocks.has(file)) {
      return process.pid; // a bridge in this process
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const descriptor = openSync(file, 'wx', 0o600);
        try {
          writeSync(descriptor, `${process.pid}\n`);
        } finally {
          closeSync(descriptor);
        }
        heldLocks.add(file);
        this.locked = true;
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return null; // no lock to be had (a read-only home): read anyway
        }
      }
      let pid = 0;
      try {
        pid = Number.parseInt(readFileSync(file, 'utf8')) || 0;
      } catch {
        continue; // it just went away: try again
      }
      if (pid > 0 && pid !== process.pid && pidAlive(pid)) {
        return pid;
      }
      rmSync(file, { force: true }); // left by a bridge that is gone
    }
    return 0;
  }

  private unlock(): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    const file = lockFile(this.home);
    heldLocks.delete(file);
    try {
      if (Number.parseInt(readFileSync(file, 'utf8')) === process.pid) {
        rmSync(file, { force: true });
      }
    } catch {
      /* already gone */
    }
  }

  private kick(): void {
    if (this.kickTimer || this.stopped) {
      return;
    }
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.drain();
    }, this.opts.debounceMs).unref();
  }

  /** Reads what's new in the spool and makes its turns. Runs one at a time; resolves once this pass is done. */
  drain(): Promise<void> {
    this.chain = this.chain
      .then(() => this.pass())
      .catch((err: Error) => this.log(`turn spool: ${err.stack || err}`));
    return this.chain;
  }

  private async pass(): Promise<void> {
    if (this.stopped || this.off) {
      return;
    }
    this.heldUntil = 0;
    const settings = { exclude: readSettings(this.home).captureExclude };
    const transcripts = new Map<string, Transcript | null>();
    this.adoptStray();
    const rotated = this.state.rotated;
    if (rotated) {
      const file = path.join(path.dirname(spoolFile(this.home)), rotated.name);
      // a file found with no place saved is read from its start with empty state, which it keeps to itself
      const state = rotated.replay ? emptyState() : this.state;
      const result = await this.consume(
        file,
        rotated.offset,
        (offset) => (rotated.offset = offset),
        { ...settings, transcripts, state },
        false,
      );
      if (result.done && this.opts.now() - rotated.at >= this.opts.rotateGraceMs) {
        rmSync(file, { force: true });
        this.state.rotated = null;
      }
      this.save();
      if (result.held) {
        this.scheduleHold(); // the main spool's records come after this one's
        return;
      }
    }
    const result = await this.consume(
      spoolFile(this.home),
      this.state.offset,
      (offset) => (this.state.offset = offset),
      { ...settings, transcripts, state: this.state },
      true,
    );
    if (result.done && result.size > this.opts.rotateBytes && !this.state.rotated) {
      this.rotate();
    }
    this.save();
    this.scheduleHold();
  }

  private scheduleHold(): void {
    if (this.heldUntil && !this.stopped) {
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
      }
      this.holdTimer = setTimeout(
        () => void this.drain(),
        Math.max(50, this.heldUntil - this.opts.now() + 20),
      ).unref();
    }
  }

  /**
   * An `.old` file left by a crash between the rename and the saved state: it is read from its start, but with empty
   * pairing state (the state now is the one its end left). The place saved for the main spool was a place in that file,
   * so the new main spool is read from its start, with the state kept.
   */
  private adoptStray(): void {
    if (this.state.rotated) {
      return;
    }
    try {
      const stray = readdirSync(path.dirname(spoolFile(this.home))).find((name) =>
        /^incoming\.[0-9]+\.old$/.test(name),
      );
      if (stray) {
        this.state.rotated = { name: stray, offset: 0, at: 0, replay: true };
        this.state.offset = 0;
      }
    } catch {
      /* no folder yet */
    }
  }

  private rotate(): void {
    const name = `incoming.${this.opts.now()}.old`;
    try {
      renameSync(spoolFile(this.home), path.join(path.dirname(spoolFile(this.home)), name));
    } catch {
      return;
    }
    this.state.rotated = { name, offset: this.state.offset, at: this.opts.now() };
    this.state.offset = 0;
  }

  /**
   * Reads `file` from `from` to its end (or to a Stop that is too new), a line at a time, saving the place after each.
   * `done` is true when the whole file has been read.
   */
  private async consume(
    file: string,
    from: number,
    setOffset: (offset: number) => void,
    context: ReadContext,
    startOverOnShrink: boolean,
  ): Promise<{ done: boolean; size: number; held: boolean }> {
    let offset = from;
    for (;;) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return { done: true, size: 0, held: false };
      }
      if (offset > size) {
        // the file was emptied or replaced: read it all again (turns already kept are skipped). What it paired before
        // belongs to the old contents, and pairing with it again would run the new file's first records backward.
        offset = 0;
        setOffset(0);
        if (startOverOnShrink) {
          context.state.open = {};
          context.state.last = {};
        }
      }
      if (offset === size) {
        return { done: true, size, held: false };
      }
      const buffer = Buffer.alloc(Math.min(size - offset, CHUNK));
      const descriptor = openSync(file, 'r');
      try {
        readSync(descriptor, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(descriptor);
      }
      let taken = 0;
      for (;;) {
        const newline = buffer.indexOf(10, taken);
        if (newline < 0) {
          break;
        }
        const line = buffer.toString('utf8', taken, newline);
        if (line.trim() && (await this.handle(line, context)) === 'hold') {
          return { done: false, size, held: true };
        }
        taken = newline + 1;
        setOffset(offset + taken);
        this.save();
      }
      if (taken === 0) {
        if (buffer.length === size - offset && buffer.length < MAX_LINE * 2) {
          return { done: false, size, held: false }; // a line still being written
        }
        // a "line" far longer than any record: skip it
        this.log(`turn spool: skipped ${buffer.length} bytes with no line end`);
        taken = buffer.length;
        setOffset(offset + taken);
      }
      offset += taken;
    }
  }

  private async handle(line: string, context: ReadContext): Promise<'done' | 'hold'> {
    if (line.length > MAX_LINE) {
      this.log(`turn spool: skipped a ${line.length}-character line`);
      return 'done';
    }
    const parsed = parseRecord(line);
    if ('error' in parsed) {
      this.log(`turn spool: skipped a line (${parsed.error})`);
      return 'done';
    }
    const rec = parsed.record;
    // the transcript may not have its last lines yet: a Stop waits a moment
    // (a time well ahead of the clock isn't waited for: a wrong clock would hold every line behind it)
    const ready = Date.parse(rec.at) + this.opts.settleMs;
    const wait = ready - this.opts.now();
    if (rec.event === 'stop' && wait > 0 && wait <= this.opts.settleMs + CLOCK_SKEW_MS) {
      this.heldUntil = ready;
      return 'hold';
    }
    if (isExcluded(context.exclude, rec.top)) {
      return 'done';
    }
    const pair = pairRecord(context.state, rec);
    if (pair) {
      await this.make(pair, context.transcripts);
    }
    return 'done';
  }

  private async make(pair: Pair, transcripts: Map<string, Transcript | null>): Promise<void> {
    let said = { prompt: null as string | null, summary: null as string | null };
    if (pair.transcript) {
      try {
        if (!transcripts.has(pair.transcript)) {
          transcripts.set(pair.transcript, Transcript.open(pair.transcript, pair.session));
        }
        const transcript = transcripts.get(pair.transcript);
        const startAt = Date.parse(pair.started_at);
        if (transcript) {
          said = textOfTurn(
            transcript.entriesSince(startAt - PROMPT_LEAD_MS),
            startAt,
            Date.parse(pair.at),
            { fromPrompt: pair.from_prompt, interrupted: pair.interrupted },
          );
        }
      } catch {
        /* a transcript that can't be read: the turn has no prompt or summary */
      }
    }
    try {
      const turn = await this.turns.record({
        id: turnIdOf(
          pair.session,
          pair.top,
          pair.base_tree,
          pair.head_tree,
          pair.started_at,
          pair.at,
        ),
        repo_path: pair.top,
        base_tree: pair.base_tree,
        head_tree: pair.head_tree,
        session: pair.session,
        branch: pair.branch,
        at: pair.at,
        prompt: said.prompt,
        summary: said.summary,
        interrupted: pair.interrupted,
      });
      if (turn) {
        this.onTurn(turn);
      }
    } catch (err) {
      const where = `${pair.session.slice(0, 8)} at ${pair.at} in ${pair.top}`;
      this.log(
        err instanceof MissingTreesError
          ? `turn spool: skipped the turn of session ${where}: its snapshot trees are gone (git gc prunes them after about 2 weeks)`
          : `turn spool: skipped the turn of session ${where}: ${(err as Error).message}`,
      );
    }
  }
}

/** What `once-upon doctor` says about capture: the spool's size, how much of it has been read and the last record's time. */
export interface SpoolStatus {
  exists: boolean;
  size: number;
  unreadRecords: number;
  /** the time of the spool's last record */
  lastAt: string | null;
  /** when the bridge last saved its place */
  readAt: string | null;
}

export function spoolStatus(home: string): SpoolStatus {
  const file = spoolFile(home);
  if (!existsSync(file)) {
    return { exists: false, size: 0, unreadRecords: 0, lastAt: null, readAt: null };
  }
  const size = statSync(file).size;
  const saved = readJson<{ offset?: number; saved_at?: string }>(stateFile(home), {}) || {};
  let offset = Number.isInteger(saved.offset) ? (saved.offset as number) : 0;
  if (offset > size) {
    offset = 0;
  }
  const descriptor = openSync(file, 'r');
  let tail = '';
  let unread = '';
  try {
    const from = Math.max(0, size - 8192);
    const buffer = Buffer.alloc(size - from);
    readSync(descriptor, buffer, 0, buffer.length, from);
    tail = buffer.toString('utf8');
    const rest = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
    readSync(descriptor, rest, 0, rest.length, offset);
    unread = rest.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
  const lines = tail.split('\n').filter((line) => line.trim());
  let lastAt: string | null = null;
  for (const line of lines.reverse()) {
    try {
      const stamp = JSON.parse(line).at;
      if (typeof stamp === 'string') {
        lastAt = stamp;
        break;
      }
    } catch {
      /* a half-written line */
    }
  }
  const unreadRecords = unread
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.trim()).length;
  return { exists: true, size, unreadRecords, lastAt, readAt: saved.saved_at || null };
}
