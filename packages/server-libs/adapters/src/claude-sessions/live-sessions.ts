import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
/*
 * Claude Code's own session registry (~/.claude/sessions, one <pid>.json per running session): which sessions are live, in
 * which folder, busy or idle, and on which tty. A session counts as live when its pid is running and (when ps can say) it
 * started when the file says it did.
 */
import { collapse } from '@once-upon-a-diff/terms/text';
import { run } from '../os.ts';

/** A live session as the board knows it. */
export interface LiveSession {
  pid: number;
  session: string;
  cwd: string;
  name: string | null;
  tty: string | null;
  /** Claude Code's registry status */
  status: 'busy' | 'idle' | string;
  /** when the registry last changed it (ms since the epoch) */
  statusAt: number | null;
  startedAt: number | null;
  /** Claude Code's session kind ("interactive" for one at a prompt), when the registry says */
  kind?: string | null;
}

interface Registry {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  name?: unknown;
  status?: unknown;
  statusUpdatedAt?: unknown;
  startedAt?: unknown;
  procStart?: unknown;
  kind?: unknown;
}

/** What the reader found in the registry folder: whether it could be read, and what became of each `<pid>.json` it found. */
export interface RegistryHealth {
  folder: 'ok' | 'missing' | 'unreadable';
  /** files found, whatever became of them (not one that vanished between the listing and the read) */
  seen: number;
  /** of those, JSON this reader does not know the shape of (a field renamed): the sign of a format change */
  skipped: number;
  /** of those, files that did not parse even on a second read: a half-written file or a crashed session's leftover */
  broken: number;
  /** of those, files that could not be read at all (permissions, say) */
  unreadable: number;
}

/** What is wrong with the registry, in a line for doctor, or null when nothing is. Broken files alone are not a problem. */
export function registryProblem({
  folder,
  seen,
  skipped,
  broken,
  unreadable,
}: RegistryHealth): string | null {
  if (folder !== 'ok') {
    return `the sessions folder is ${folder}: Claude Code may have moved it`;
  }
  if (seen && unreadable === seen) {
    return `${seen} session file${seen === 1 ? '' : 's'} found and none could be read: check their permissions`;
  }
  const parsed = seen - broken - unreadable;
  if (skipped && skipped === parsed) {
    return `${parsed} session file${parsed === 1 ? '' : 's'} found and none could be used: Claude Code may have changed their format`;
  }
  return skipped ? `${skipped} of ${parsed} session files could not be used` : null;
}

/** What doctor mentions as information when the registry is fine: files that did not parse or could not be read. */
export function registryNote({ broken, unreadable }: RegistryHealth): string {
  return [
    broken ? `${broken} not valid JSON (half-written or left by a crashed session)` : '',
    unreadable ? `${unreadable} unreadable` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The board's one-line notice: only when files are there and every one that parsed has a shape it does not know. */
export function registryNotice({
  seen,
  skipped,
  broken,
  unreadable,
}: RegistryHealth): string | null {
  return skipped && skipped === seen - broken - unreadable
    ? "Claude Code's session files could not be read: run once-upon doctor"
    : null;
}

type Parsed = LiveSession & { procStart: string | null };

/** How long a file that does not parse waits before its one second read (a registry file caught mid-write). */
const REREAD_AFTER_MS = 50;

type Read = { parsed: unknown } | 'gone' | 'broken' | 'unreadable';

function readOne(file: string): Read {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // a session that ended between the listing and the read is not a file at all
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return 'broken';
  }
}

/** Reads every registry file, without asking whether the pid still runs. */
async function scan(
  dir: string,
): Promise<{ found: Parsed[]; health: RegistryHealth; undecided: number[] }> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      found: [],
      undecided: [],
      health: {
        folder: missing ? 'missing' : 'unreadable',
        seen: 0,
        skipped: 0,
        broken: 0,
        unreadable: 0,
      },
    };
  }
  const reads = new Map<string, Read>(names.map((name) => [name, readOne(path.join(dir, name))]));
  // a file that does not parse may be mid-write: one more read after a short pause, off the event loop
  const again = names.filter((name) => reads.get(name) === 'broken');
  if (again.length) {
    await new Promise((resolve) => setTimeout(resolve, REREAD_AFTER_MS));
    for (const name of again) {
      reads.set(name, readOne(path.join(dir, name)));
    }
  }
  const found: Parsed[] = [];
  // the pids of files the reader could not use, whose session may be live (the file name is the pid)
  const undecided: number[] = [];
  const pidOf = (name: string) => Number(name.replace(/\.json$/, ''));
  let seen = 0;
  let broken = 0;
  let unreadable = 0;
  for (const [name, read] of reads) {
    if (read === 'gone') {
      continue;
    }
    seen++;
    if (read === 'broken' || read === 'unreadable') {
      undecided.push(pidOf(name));
      broken += read === 'broken' ? 1 : 0;
      unreadable += read === 'unreadable' ? 1 : 0;
      continue;
    }
    const { parsed } = read;
    // `null`, a number or a string is valid JSON but not a registry file: it drops only itself
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    const reg = parsed as Registry;
    const pid = Number(reg.pid);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof reg.sessionId !== 'string' ||
      typeof reg.cwd !== 'string'
    ) {
      undecided.push(pidOf(name));
      continue;
    }
    found.push({
      pid,
      session: reg.sessionId,
      cwd: reg.cwd,
      name: typeof reg.name === 'string' && reg.name ? reg.name : null,
      tty: null,
      status: typeof reg.status === 'string' ? reg.status : 'idle',
      statusAt: typeof reg.statusUpdatedAt === 'number' ? reg.statusUpdatedAt : null,
      startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : null,
      kind: typeof reg.kind === 'string' ? reg.kind : null,
      procStart: typeof reg.procStart === 'string' ? collapse(reg.procStart) : null,
    });
  }
  return {
    found,
    undecided,
    health: {
      folder: 'ok',
      seen,
      skipped: seen - broken - unreadable - found.length,
      broken,
      unreadable,
    },
  };
}

/** The registry folder's health, for doctor: no ps, no liveness check. */
export const registryHealth = async (dir: string): Promise<RegistryHealth> =>
  (await scan(dir)).health;

/** The registry's live sessions: files whose pid is running, with their ttys. */
export const liveSessions = async (dir: string): Promise<LiveSession[]> =>
  (await liveRegistry(dir)).sessions;

const pidRuns = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The live sessions with what the reader could and could not use of the registry. `unknown` counts the files it could not use
 * (unreadable, half-written even on the second read, or of a shape it does not know) whose pid runs: a session may be live
 * there that is not in `sessions`, so a caller must not treat a session missing from the list as gone while it is above 0.
 */
export async function liveRegistry(
  dir: string,
): Promise<{ sessions: LiveSession[]; health: RegistryHealth; unknown: number }> {
  const { found, health, undecided } = await scan(dir);
  const unknown = undecided.filter(pidRuns).length;
  if (!found.length) {
    return { sessions: [], health, unknown };
  }
  // ps in UTC with a fixed locale answers the pid's tty and start time in the registry's procStart form; no ps (or a
  // pid it doesn't list) falls back to a plain liveness check
  const listing = await run(
    'ps',
    ['-o', 'pid=,tty=,lstart=', '-p', found.map((live) => live.pid).join(',')],
    4000,
    { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  );
  const rows = new Map<number, { tty: string; start: string }>();
  for (const line of (listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) {
      rows.set(Number(match[1]), { tty: match[2], start: collapse(match[3]) });
    }
  }
  // readdir answers in file-name order, which is string order of the pids ("10001.json" before "9998.json"), so a card's
  // sessions, the cards of lone sessions and the order of the board's lookups flipped with whatever pids the machine handed
  // out. Oldest session first, then lowest pid, is the same on every poll.
  found.sort(
    (first, second) =>
      (first.startedAt ?? Infinity) - (second.startedAt ?? Infinity) || first.pid - second.pid,
  );
  const sessions = found
    .filter((live) => {
      const row = rows.get(live.pid);
      if (row) {
        return !live.procStart || live.procStart === row.start;
      }
      if (listing !== null) {
        return false;
      }
      return pidRuns(live.pid);
    })
    .map(({ procStart: _procStart, ...live }) => ({
      ...live,
      tty: rows.get(live.pid)?.tty.replace(/^\?+$/, '') || null,
    }));
  return { sessions, health, unknown };
}
