/*
 * A lock across processes for a JSON file that the bridge and CLI processes both rewrite (builds.json, fixes.json):
 * `<file>.lock`, made with O_EXCL ('wx') so only one process can make it, holding the maker's pid. A read-modify-write
 * under it can't lose another process's write. The work inside is a few milliseconds of file I/O, so a waiter just
 * waits. A lock whose process is gone, or that is older than LOCK_STALE_MS, was left by a crash and is taken over.
 */
import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { pidAlive } from '../os.ts';
import { readJson, writeJsonAtomic } from './json-file.ts';
import { removeFile } from './files.ts';

const LOCK_STALE_MS = 10_000;
const STEP_MS = 5;

/** The locks this process holds, by path, and how deep: a nested withLock on the same file runs at once. */
const held = new Map<string, number>();

/** Which lock file is there now: its inode, mtime and text, or null when there's none. */
function identity(lock: string): { key: string; mtimeMs: number; text: string } | null {
  try {
    const stat = statSync(lock);
    const text = readFileSync(lock, 'utf8');
    return { key: `${stat.ino}:${stat.mtimeMs}:${text}`, mtimeMs: stat.mtimeMs, text };
  } catch {
    return null; // let go while we looked
  }
}

/**
 * The identity of the lock there now when a crash left it (its process is gone, or it's older than LOCK_STALE_MS),
 * else null.
 */
function stale(lock: string): string | null {
  const seen = identity(lock);
  if (!seen) {
    return null; // gone already: the next try makes it
  }
  try {
    const pid = Number(JSON.parse(seen.text).pid);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) {
      return seen.key;
    }
  } catch {
    // half-written: judge it by its age
  }
  return Date.now() - seen.mtimeMs > LOCK_STALE_MS ? seen.key : null;
}

/** Test-only: runs between judging a lock stale and taking it over, where another process may have made a new one. */
export const takeoverSeam: { beforeRemove: (() => void) | null } = { beforeRemove: null };

function acquire(lock: string): void {
  for (;;) {
    try {
      const handle = openSync(lock, 'wx', 0o600);
      try {
        writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        closeSync(handle);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const judged = stale(lock);
    if (judged) {
      takeoverSeam.beforeRemove?.();
      // the holder judged may have let go and another made a fresh lock since: remove only the one judged
      if (identity(lock)?.key === judged) {
        removeFile(lock);
      }
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STEP_MS);
  }
}

/** Runs `work` while this process holds `<file>.lock`, and lets it go after, also when `work` throws. */
export function withLock<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`;
  const depth = held.get(lock) || 0;
  if (!depth) {
    acquire(lock);
  }
  held.set(lock, depth + 1);
  try {
    return work();
  } finally {
    if (depth) {
      held.set(lock, depth);
    } else {
      held.delete(lock);
      removeFile(lock);
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
