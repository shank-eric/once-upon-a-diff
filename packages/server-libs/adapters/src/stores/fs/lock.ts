/*
 * A lock across processes for a JSON file that the bridge and CLI processes both rewrite (builds.json, fixes.json) or
 * that a check-then-append must not race on (backlog.jsonl, agents.jsonl): `<file>.lock`, made with O_EXCL ('wx') so only
 * one process can make it, holding the maker's pid and a token for that acquire. A read-modify-write under it can't lose
 * another process's write. The work inside is a few milliseconds of file I/O, so a waiter just waits (a waiter in the
 * bridge blocks its HTTP server meanwhile: a known limit).
 *
 * A lock whose pid is alive is never taken over, however old: a holder stalled past any age still holds it. A lock whose
 * process is gone was left by a crash and is taken over, and so is one with no readable pid that is older than
 * LOCK_STALE_MS (a process died between making the file and writing its pid). A takeover never removes a lock it did not
 * judge: one waiter at a time takes `<file>.lock.reap` (also O_EXCL), judges the lock again under it and removes it only
 * if it is still stale, the shape heavy-lock.ts uses. A holder lets go only of a lock that still holds its own pid and token.
 *
 * A live pid can still be the wrong one, so the wait has two ways out that never take a live holder over: a lock naming this
 * process but not held here, or naming a pid that started after the lock was made (the pid was reused), is stale; and a wait
 * past LOCK_WAIT_MS throws an error that names the lock, its pid and its time, so a stopped holder or a pid that cannot be
 * judged stops a request or a command with a message instead of freezing it.
 */
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pidAlive, startOf } from '../../os.ts';
import { readJson, writeJsonAtomic } from './json-file.ts';
import { ensureDir, removeFile } from './files.ts';

/** A lock with no readable pid this old was left by a process that died before writing it. */
const LOCK_STALE_MS = 10_000;
/** A reaper that crashed holding `<lock>.reap` leaves it behind; one this old may be removed. */
const REAP_STALE_MS = 10_000;
const STEP_MS = 5;
/** A wait for a live holder this long throws: the longest real hold is a few seconds (two 3 s git calls in `agent start`). */
const LOCK_WAIT_MS = 30_000;
/** While waiting, whether the holder's pid was reused is asked (it runs `ps`) once at the start and then this often. */
const START_CHECK_MS = 3_000;

/** Test-only: the wait limit, so a test of the error does not wait 30 s. */
export const waitSeam = { limitMs: LOCK_WAIT_MS };

/** The locks this process holds, by path: how deep (a nested withLock on the same file runs at once) and the acquire's token. */
const held = new Map<string, { depth: number; token: string }>();

/** What the lock file holds: its text and age, or null when there's no file. */
function read(file: string): { text: string; mtimeMs: number } | null {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    return { text: readFileSync(file, 'utf8'), mtimeMs };
  } catch {
    return null; // let go while we looked
  }
}

/** The pid, token and time a lock names (the pid null when the text is half-written). */
function owner(text: string): { pid: number | null; token: unknown; at: string | null } {
  try {
    const value = JSON.parse(text);
    const pid = Number(value.pid);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      token: value.token,
      at: typeof value.at === 'string' ? value.at : null,
    };
  } catch {
    return { pid: null, token: undefined, at: null };
  }
}

/** Whether the pid's process started after the lock was made: then the pid was reused and the holder is gone. Asks `ps`. */
function pidReused(pid: number, madeAt: string | null): boolean {
  const made = madeAt ? Date.parse(madeAt) : NaN;
  const started = startOf(pid);
  const began = started ? Date.parse(`${started} UTC`) : NaN; // ps says the start to the second, rounded down
  return Number.isFinite(made) && Number.isFinite(began) && began > made;
}

/**
 * Whether a crash left the lock there now: its process is gone, or it names none readable and is over LOCK_STALE_MS old, or
 * it names this process without being held here, or (with `askStart`) its pid started after the lock was made.
 */
function stale(lock: string, askStart: boolean): boolean {
  const seen = read(lock);
  if (!seen) {
    return false; // gone already: the next try makes it
  }
  const { pid, at } = owner(seen.text);
  if (!pid) {
    return Date.now() - seen.mtimeMs > LOCK_STALE_MS;
  }
  if (pid === process.pid) {
    return !held.has(lock); // an earlier process had this pid; a lock we hold is never in here
  }
  return !pidAlive(pid) || (askStart && pidReused(pid, at));
}

/** Test-only: runs under the reap guard between judging a lock stale and judging it again, where another may have made a new one. */
export const takeoverSeam: {
  beforeRemove: (() => void) | null;
  beforeGuardRemove: (() => void) | null;
} = {
  beforeRemove: null,
  beforeGuardRemove: null,
};

/**
 * Removes the guard a crashed reaper left, if it is old. It is judged by its identity and removed by moving it to a name no
 * one else has: a fresh guard made since the judging is not the one judged, so it is put back and stays.
 */
function clearOldGuard(guard: string): void {
  let judged;
  try {
    judged = statSync(guard);
  } catch {
    return; // gone already
  }
  if (Date.now() - judged.mtimeMs <= REAP_STALE_MS) {
    return;
  }
  takeoverSeam.beforeGuardRemove?.();
  const moved = `${guard}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(guard, moved);
  } catch {
    return; // another waiter took it
  }
  try {
    const now = statSync(moved);
    if (now.ino !== judged.ino || now.mtimeMs !== judged.mtimeMs) {
      try {
        linkSync(moved, guard); // a live reaper's guard: back where it was (fails if yet another was made, which then stands)
      } catch {
        // the guard it was
      }
    }
  } finally {
    removeFile(moved);
  }
}

/** Removes a lock judged stale, one reaper at a time. Says whether it held the guard (false: another reaper has it). */
function reap(lock: string): boolean {
  const guard = `${lock}.reap`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    clearOldGuard(guard);
    return false;
  }
  try {
    takeoverSeam.beforeRemove?.();
    // judged again under the guard: the lock judged may have been taken over and made fresh since, and a live one stays
    if (stale(lock, true)) {
      removeFile(lock);
    }
  } finally {
    removeFile(guard);
  }
  return true;
}

/** The error for a wait that ran out: names the lock file and who it says holds it. */
function busy(lock: string): Error {
  const seen = read(lock);
  const { pid, at } = owner(seen?.text ?? '');
  return new Error(
    `${lock} has been held for over ${Math.round(waitSeam.limitMs / 1000)} s by pid ${pid ?? 'unknown'} (made ${at ?? 'at an unknown time'}). If that process is not once-upon, remove the file.`,
  );
}

/** Takes the lock and returns this acquire's token. */
function acquire(lock: string): string {
  const token = randomBytes(8).toString('hex');
  const began = Date.now();
  let nextStartCheck = began;
  for (;;) {
    try {
      const handle = openSync(lock, 'wx', 0o600);
      try {
        writeSync(
          handle,
          JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }),
        );
      } finally {
        closeSync(handle);
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const now = Date.now();
    const askStart = now >= nextStartCheck;
    if (askStart) {
      nextStartCheck = now + START_CHECK_MS;
    }
    if (stale(lock, askStart) && reap(lock)) {
      continue;
    }
    if (now - began > waitSeam.limitMs) {
      throw busy(lock);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STEP_MS);
  }
}

/** Removes the lock only when it still names this process and this acquire (a lock another holder made since is theirs). */
function release(lock: string, token: string): void {
  const now = read(lock);
  if (now) {
    const named = owner(now.text);
    if (named.pid === process.pid && named.token === token) {
      removeFile(lock);
    }
  }
}

/** Runs `work` while this process holds `<file>.lock`, and lets it go after, also when `work` throws. */
export function withLock<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`;
  const outer = held.get(lock);
  let token: string;
  if (outer) {
    token = outer.token;
  } else {
    ensureDir(path.dirname(file)); // the first write of a fresh home makes it (0700)
    token = acquire(lock);
  }
  const depth = outer?.depth ?? 0;
  held.set(lock, { depth: depth + 1, token });
  try {
    return work();
  } finally {
    if (depth) {
      held.set(lock, { depth, token });
    } else {
      held.delete(lock);
      release(lock, token);
    }
  }
}

/**
 * Reads the JSON file (the fallback when it's missing or bad), lets `change` change the value in place, and writes it
 * back when it changed, all under the file's lock. Returns what `change` returns. A throw in `change` writes nothing.
 */
export function updateJson<T, R>(file: string, fallback: T, change: (value: T) => R): R {
  return withLock(file, () => {
    const value = readJson<T>(file, fallback) ?? fallback;
    const before = JSON.stringify(value);
    const result = change(value);
    if (JSON.stringify(value) !== before) {
      writeJsonAtomic(file, value);
    }
    return result;
  });
}
