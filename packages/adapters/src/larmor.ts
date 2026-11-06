/*
 * Larmor (voice mode for Claude Code), through its own `voice_ctl` script, and nothing else of Larmor's: the board reads none
 * of its files. It asks voice_ctl for what voice and phone mode are doing and what was said, and tells it to pause, resume,
 * start, stop and run phone mode; Larmor owns the checks, the files and the bridge.
 *
 * `voice_ctl status` answers `{ok, why, away, bridge, voice: {on, paused, session_id, since, last_listen, last_speak, name,
 * last_voice: {session_id, cwd, at}}}`: voice on (its owner alive), paused, the voice session's id, when voice started (ended,
 * once it is off), when the session last listened and spoke (null while voice is off), the name the session answers to, the
 * last session that took voice mode (it outlives the end of voice mode), phone mode on, and whether the phone bridge runs.
 * Times are epoch seconds.
 *
 * `voice_ctl log [--since TS] [--limit N] [--session ID]` answers `{ok, why, lines: [...]}`, oldest first: what a session
 * said aloud `{kind: "spoken", at, text, id, session_id, status}` (`at` is when it was queued, and its status changes later)
 * and what you said `{kind: "turn", at, text, channel, id}`.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { BoardVoiceLine } from '@once-upon-a-diff/contracts/types';

export interface VoiceFiles {
  session: string;
  /** voice mode is on right now; false when it ended and the session is only remembered from today */
  on: boolean;
  name: string | null;
  /** phone mode is on while voice is on */
  away: boolean;
  /** phone mode is on, whether or not voice is */
  phoneOn: boolean;
  paused: boolean;
  /** epoch ms, 0 when it never has */
  lastListen: number;
  lastSpeak: number;
}

/** True when the epoch-ms times fall on the same local calendar day. */
function sameDay(first: number, second: number): boolean {
  return new Date(first).toDateString() === new Date(second).toDateString();
}

/**
 * The voice session once voice has started in it: while voice mode is on (voice_ctl names it), and after it ends, for the
 * rest of that local day (the last session that took voice mode), as `on: false`. Null before any voice today, and when
 * voice_ctl gave no answer (`state` null): voice is then unknown, which the board shows as off.
 */
export function readVoice(state: CtlResult | null, now: number = Date.now()): VoiceFiles | null {
  if (!state) {
    return null;
  }
  const live = state.voiceOn && !!state.sessionId;
  let session: string;
  if (live) {
    session = state.sessionId as string;
  } else {
    const last = state.lastVoice;
    // today is judged by the last activity: voice ending sets `since` (its end time), so a voice that started before
    // midnight and ended after it still counts, while one on right now always does (the live branch)
    if (!last || !sameDay(Math.max(last.at, state.since ?? 0), now)) {
      return null;
    }
    session = last.session;
  }
  return {
    session,
    on: live,
    name: state.name,
    away: live && state.away,
    phoneOn: state.away,
    paused: state.paused,
    lastListen: live ? (state.lastListen ?? 0) : 0,
    lastSpeak: live ? (state.lastSpeak ?? 0) : 0,
  };
}

/** Whether the Larmor checkout has what voice_ctl runs: its venv python and app/voice_ctl.py. */
export function phoneReady(larmorDir: string): boolean {
  return (
    existsSync(path.join(larmorDir, '.venv-app', 'bin', 'python')) &&
    existsSync(path.join(larmorDir, 'app', 'voice_ctl.py'))
  );
}

/** The subcommands of Larmor's `voice_ctl` the board runs with runVoiceCtl, and `log`, which has its own function (runVoiceLog). */
export type PhoneCommand = 'phone-on' | 'phone-off' | 'bridge-stop';
export type VoiceCommand = PhoneCommand | 'start' | 'stop' | 'status' | 'pause' | 'resume';

const CTL_COMMANDS: readonly string[] = [
  'phone-on',
  'phone-off',
  'bridge-stop',
  'start',
  'stop',
  'status',
  'pause',
  'resume',
];

/** voice_ctl waits for the bridge to listen after phone-on, up to about 10 s. */
const CTL_TIMEOUT_MS = 30 * 1000;
/** status, pause and resume read and write a file: each is over in well under a second. The board polls status, so it never waits long. */
const QUICK_TIMEOUT_MS = 3 * 1000;
/**
 * start scans the sessions, types into iTerm and waits up to 15 s for voice (after a pause it cleared, up to 8 s more for the
 * engine), with each iTerm or ps call allowed 5 s: about 40 s in the worst case. The kill must not come after /larmor was typed.
 */
const START_TIMEOUT_MS = 70 * 1000;

/**
 * The two waits a test may widen with setVoiceWaits (production never calls it): how long a build with no answer yet waits for
 * voice_ctl before going on without it, and the kill of each quick call (status, log, pause, resume). A test on a loaded
 * machine can need longer than either for the fake voice_ctl, a node process, to start; the defaults are the board's own.
 */
export interface VoiceWaits {
  coldWaitMs: number;
  quickTimeoutMs: number;
}
const DEFAULT_WAITS: VoiceWaits = { coldWaitMs: 1000, quickTimeoutMs: QUICK_TIMEOUT_MS };
let waits: VoiceWaits = DEFAULT_WAITS;
/** For tests only: widen the cold wait and the quick-call kill, or pass null for the board's own. */
export function setVoiceWaits(next: Partial<VoiceWaits> | null): void {
  waits = next ? { ...DEFAULT_WAITS, ...next } : DEFAULT_WAITS;
}

function timeoutOf(command: VoiceCommand): number {
  if (command === 'start') {
    return START_TIMEOUT_MS;
  }
  return command === 'status' || command === 'pause' || command === 'resume'
    ? waits.quickTimeoutMs
    : CTL_TIMEOUT_MS;
}

/** The last non-empty line of some output (a Python traceback ends with its reason), cut to a short message. */
function lastLine(text: string): string {
  const line = text.trim().split('\n').pop()?.trim() ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Larmor's voice_ctl failed or printed nothing the board can use. The board answers it as a 502. */
export class VoiceCtlError extends Error {}

export interface CtlResult {
  ok: boolean;
  why: string;
  /** phone mode is on */
  away: boolean;
  /** the phone bridge runs */
  bridge: boolean;
  /** voice mode is on, after the command ran */
  voiceOn: boolean;
  paused: boolean;
  /** the voice session's id while voice is on, once Larmor has recorded it */
  sessionId: string | null;
  /** epoch ms: when voice started, or ended once it is off */
  since: number | null;
  /** epoch ms: null while voice is off */
  lastListen: number | null;
  lastSpeak: number | null;
  /** the name the voice session answers to */
  name: string | null;
  /** the last session that took voice mode (it outlives the end of voice mode); null when Larmor has none usable */
  lastVoice: { session: string; cwd: string | null; at: number } | null;
}

/** Epoch seconds from voice_ctl as epoch ms, null when it is not a finite number. */
function millis(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** One voice_ctl call: runs the venv python from Larmor's checkout (no shell) and returns the JSON object on its last line. */
function execCtl(
  larmorDir: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const python = path.join(larmorDir, '.venv-app', 'bin', 'python');
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ['app/voice_ctl.py', ...args],
      { cwd: larmorDir, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop() ?? '';
        try {
          const got = JSON.parse(line) as Record<string, unknown> | null;
          if (got && typeof got === 'object' && typeof got.ok === 'boolean') {
            return resolve(got);
          }
        } catch {
          /* no result line */
        }
        reject(
          new VoiceCtlError(
            err
              ? `Larmor's voice_ctl ${label} failed: ${lastLine(String(stderr)) || err.message.split('\n')[0]}`
              : `Larmor's voice_ctl ${label} printed no result`,
          ),
        );
      },
    );
  });
}

/**
 * Runs `python app/voice_ctl.py <command>` from Larmor's checkout with its own venv python (no shell, a fixed list of
 * commands, a timeout) and returns the one JSON line it prints. Larmor owns the checks and the bridge; the board only asks.
 */
export function runVoiceCtl(
  larmorDir: string,
  command: VoiceCommand,
  session?: string,
): Promise<CtlResult> {
  if (!CTL_COMMANDS.includes(command)) {
    throw new Error(`not an allowed voice_ctl command: ${command}`);
  }
  // a session id goes only to start, and only in the id's own shape (execFile, so no shell either way)
  if (
    session !== undefined &&
    (command !== 'start' || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(session))
  ) {
    throw new Error(`not an allowed voice_ctl argument for ${command}`);
  }
  return execCtl(
    larmorDir,
    [command, ...(session ? [session] : [])],
    timeoutOf(command),
    command,
  ).then((got) => {
    const voice = (got.voice && typeof got.voice === 'object' ? got.voice : {}) as Record<
      string,
      unknown
    >;
    const id = voice.session_id;
    const last = voice.last_voice as Record<string, unknown> | null | undefined;
    const lastAt = last && typeof last === 'object' ? millis(last.at) : null;
    return {
      ok: got.ok === true,
      why: typeof got.why === 'string' ? got.why : '',
      away: got.away === true,
      bridge: got.bridge === true,
      voiceOn: voice.on === true,
      paused: voice.paused === true,
      sessionId: typeof id === 'string' && id ? id : null,
      since: millis(voice.since),
      lastListen: millis(voice.last_listen),
      lastSpeak: millis(voice.last_speak),
      name: typeof voice.name === 'string' && voice.name.trim() ? voice.name.trim() : null,
      // a last voice without a usable time is no last voice
      lastVoice:
        last &&
        typeof last === 'object' &&
        typeof last.session_id === 'string' &&
        last.session_id &&
        lastAt !== null
          ? {
              session: last.session_id,
              cwd: typeof last.cwd === 'string' ? last.cwd : null,
              at: lastAt,
            }
          : null,
    };
  });
}

/** How old a good answer may get before a build starts a refresh in the background (about one board poll). */
export const STATUS_FRESH_MS = 2 * 1000;
/** After voice_ctl failed to answer status, how long the board does not ask again. */
const STATUS_RETRY_MS = 10 * 1000;

/** The last answer (null for a failed call) and when it came in (the call's end, epoch ms). */
const statusKept = new Map<string, { value: CtlResult | null; at: number }>();
const statusRunning = new Map<string, Promise<void>>();
/** Bumped when the board forgets, so a call that started before does not store what it saw. */
let statusGeneration = 0;

function refreshStatus(larmorDir: string): Promise<void> {
  const running = statusRunning.get(larmorDir);
  if (running) {
    return running;
  }
  const generation = statusGeneration;
  const call: Promise<void> = runVoiceCtl(larmorDir, 'status')
    .catch(() => null)
    .then((value) => {
      // the call's own entry always goes; its answer is kept only if the board did not forget or learn better meanwhile
      if (statusRunning.get(larmorDir) === call) {
        statusRunning.delete(larmorDir);
      }
      if (generation === statusGeneration) {
        statusKept.set(larmorDir, { value, at: Date.now() });
      }
    });
  statusRunning.set(larmorDir, call);
  return call;
}

/**
 * What Larmor's voice_ctl last said voice and phone mode are doing, or null when it cannot say (no checkout, it failed, timed
 * out or printed nothing usable: the board then shows voice as off). The board does not wait for voice_ctl: a build uses the
 * last answer, and when that is older than a poll (a failure: 10 s) starts one refresh in the background, one at a time. Only
 * with no answer at all does a build wait, and for a second at most (the cold wait, which a test may widen with
 * setVoiceWaits). Never rejects.
 */
export function voiceState(larmorDir: string): Promise<CtlResult | null> {
  const kept = statusKept.get(larmorDir);
  if (kept) {
    if (Date.now() - kept.at >= (kept.value ? STATUS_FRESH_MS : STATUS_RETRY_MS)) {
      void refreshStatus(larmorDir);
    }
    return Promise.resolve(kept.value);
  }
  const call = refreshStatus(larmorDir);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), waits.coldWaitMs);
    void call.then(() => {
      clearTimeout(timer);
      resolve(statusKept.get(larmorDir)?.value ?? null);
    });
  });
}

/**
 * After the board ran a voice_ctl command: its result carries the state after the command, so it is the new answer (the next
 * build needs no call), and any status call already running, which may have read the state before the command, is dropped.
 */
export function rememberVoiceState(larmorDir: string, result: CtlResult): void {
  statusGeneration += 1;
  statusRunning.clear();
  statusKept.set(larmorDir, { value: result, at: Date.now() });
}

/** Forget what voice_ctl last said, and any call already running, after a command whose result is unknown: the next build asks again. */
export function forgetProbes(): void {
  statusGeneration += 1;
  statusKept.clear();
  statusRunning.clear();
  logKept.clear();
  logRunning.clear();
}

/** How many lines the voice panel keeps (it scrolls). */
const VOICE_LINES = 20;
/** The first fetch asks for the newest lines up to this many, and later ones only for the last few minutes. */
const LOG_FIRST_LIMIT = 60;
const LOG_WINDOW_S = 5 * 60;
/** The most lines a session's log keeps between fetches. */
const LOG_KEEP = 200;

/**
 * Runs `voice_ctl log` for one session and returns its lines as the panel shows them (what it said, then what you said, by
 * time, oldest first). `sinceSeconds` is epoch seconds: only lines after it.
 */
export async function runVoiceLog(
  larmorDir: string,
  session: string,
  limit: number,
  sinceSeconds?: number,
): Promise<{ key: string; line: BoardVoiceLine }[]> {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._:-]{0,199}$/.test(session)) {
    throw new Error('not an allowed voice_ctl log session');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('not an allowed voice_ctl log limit');
  }
  if (sinceSeconds !== undefined && !Number.isFinite(sinceSeconds)) {
    throw new Error('not an allowed voice_ctl log time');
  }
  const got = await execCtl(
    larmorDir,
    [
      'log',
      ...(sinceSeconds === undefined ? [] : ['--since', String(sinceSeconds)]),
      '--limit',
      String(limit),
      '--session',
      session,
    ],
    waits.quickTimeoutMs,
    'log',
  );
  if (!got.ok) {
    throw new VoiceCtlError(`Larmor's voice_ctl log failed: ${String(got.why || 'no reason')}`);
  }
  const lines = Array.isArray(got.lines) ? (got.lines as Record<string, unknown>[]) : [];
  const who: Record<string, BoardVoiceLine['who']> = { spoken: 'voice', turn: 'you' };
  return lines.flatMap((one) => {
    const when = one && typeof one === 'object' ? millis(one.at) : null;
    const speaker = typeof one?.kind === 'string' ? who[one.kind] : undefined;
    if (when === null || !speaker || typeof one.text !== 'string' || !one.text.trim()) {
      return [];
    }
    // a line is told by its id when it has one, since a spoken line's status changes under the same id
    const key = `${one.kind}:${typeof one.id === 'string' && one.id ? one.id : `${when}|${one.text}`}`;
    return [{ key, line: { who: speaker, text: one.text.trim(), at: when } }];
  });
}

/** One session's lines kept between builds: by key, so a line that comes again (its status changed) replaces itself. */
interface KeptLog {
  entries: Map<string, BoardVoiceLine>;
  lines: BoardVoiceLine[];
  /** when the last call ended, epoch ms */
  at: number;
  failed: boolean;
  /** the newest line's time, epoch s, as of the last good call (0 for none) */
  newest: number;
  /** the last good call ran with voice off: nothing new can come, so no more calls until voice is on again */
  settled: boolean;
}
const logKept = new Map<string, KeptLog>();
const logRunning = new Map<string, Promise<void>>();

function refreshLog(larmorDir: string, session: string, live: boolean): Promise<void> {
  const key = `${larmorDir}\n${session}`;
  const running = logRunning.get(key);
  if (running) {
    return running;
  }
  const generation = statusGeneration;
  const kept = logKept.get(key);
  // The first call takes the newest lines. Later ones re-read from five minutes before the newest line the last good call
  // saw (and no later than five minutes ago), so the window always overlaps what is already kept even after a long gap
  // with no polls or failing calls: a spoken line keeps the time it was queued while its status changes, so asking only
  // after the last time seen would miss those changes.
  const since = kept?.entries.size
    ? Math.min(kept.newest - LOG_WINDOW_S, Date.now() / 1000 - LOG_WINDOW_S)
    : undefined;
  const call: Promise<void> = runVoiceLog(
    larmorDir,
    session,
    since === undefined ? LOG_FIRST_LIMIT : LOG_KEEP,
    since,
  )
    .then((got) => ({ got, failed: false }))
    .catch(() => ({ got: [], failed: true }))
    .then(({ got, failed }) => {
      // the call's own entry always goes, so the next poll can make a new call; a stale call only loses its lines
      if (logRunning.get(key) === call) {
        logRunning.delete(key);
      }
      if (generation !== statusGeneration) {
        return;
      }
      const entries = new Map(kept?.entries);
      for (const { key: lineKey, line } of got) {
        entries.set(lineKey, line);
      }
      const newest = [...entries.entries()].sort((first, second) => first[1].at - second[1].at);
      const keptEntries = new Map(newest.slice(-LOG_KEEP));
      for (const other of [...logKept.keys()]) {
        // one voice session is pinned at a time: drop the lines of a session that came before
        if (other.startsWith(`${larmorDir}\n`) && other !== key) {
          logKept.delete(other);
        }
      }
      const newestAt = newest.length ? newest[newest.length - 1][1].at / 1000 : 0;
      logKept.set(key, {
        entries: keptEntries,
        lines: [...keptEntries.values()].slice(-VOICE_LINES),
        at: Date.now(),
        failed,
        newest: failed ? (kept?.newest ?? 0) : newestAt,
        settled: !failed && !live,
      });
    });
  logRunning.set(key, call);
  return call;
}

/**
 * The voice session's last few lines, oldest first, from `voice_ctl log` (what it said, and what you said since it first
 * spoke). Like the status, a build does not wait for it once there are lines: it gets the last ones, and one refresh runs in
 * the background when they are over a poll old (after a failure, 10 s). With no lines yet a build waits a second at most
 * (the cold wait, as for voiceState). Never rejects; [] when voice_ctl cannot say.
 */
export function voiceLines(
  larmorDir: string,
  session: string,
  live: boolean,
): Promise<BoardVoiceLine[]> {
  const key = `${larmorDir}\n${session}`;
  const kept = logKept.get(key);
  if (kept) {
    // with voice off and the lines fetched once since it ended, nothing new can come: no more calls until voice is on again
    const idle = kept.settled && !live;
    if (!idle && Date.now() - kept.at >= (kept.failed ? STATUS_RETRY_MS : STATUS_FRESH_MS)) {
      void refreshLog(larmorDir, session, live);
    }
    return Promise.resolve(kept.lines);
  }
  const call = refreshLog(larmorDir, session, live);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), waits.coldWaitMs);
    void call.then(() => {
      clearTimeout(timer);
      resolve(logKept.get(key)?.lines ?? []);
    });
  });
}
