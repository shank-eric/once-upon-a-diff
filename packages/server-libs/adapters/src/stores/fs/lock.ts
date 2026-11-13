/*
 * A lock across processes for a JSON file that the bridge and CLI processes both rewrite (builds.json, fixes.json) or
 * that a check-then-append must not race on (backlog.jsonl, agents.jsonl): the folder `<file>.lock`, made and judged by the
 * proper-lockfile package (see folder-lock.ts). A read-modify-write under it can't lose another process's write. The work
 * inside is a few milliseconds of file I/O, so a waiter just waits (a waiter in the bridge blocks its HTTP server
 * meanwhile: a known limit).
 *
 * The package judges a lock stale by its age alone: a lock untouched for LOCK_STALE_MS is taken, whoever made it and whether
 * or not that process is alive. A crash (SIGKILL) therefore blocks waiters for up to LOCK_STALE_MS, and a holder stalled past
 * it (a stopped process, a laptop asleep mid-write) can lose its lock to another process; the holder's own release then
 * fails or removes the new holder's lock (the package removes whatever is at the path), and withLock swallows that. The wait limit is above LOCK_STALE_MS, so a waiter after a crash gets the lock instead of the error.
 * A wait past the limit throws an error that names the lock, so a request or a command stops with a message instead of
 * freezing.
 *
 * `<file>.lock` was a file in earlier versions (made with O_EXCL, holding a pid): one left at the path is cleared away once
 * it is over two seconds old (an old holder holds for milliseconds; a younger one is waited for).
 */
import path from 'node:path';
import { lockFolder } from './folder-lock.ts';
import { readJson, writeJsonAtomic } from './json-file.ts';
import { ensureDir } from './files.ts';

/** A lock folder this old was left by a crashed process (or held by one stalled for this long). */
const LOCK_STALE_MS = 30_000;
/** A wait for a holder this long throws: above LOCK_STALE_MS, so a crashed holder's lock is taken before the wait gives up. */
const LOCK_WAIT_MS = 35_000;
/** A lock FILE from an earlier version this old is removed; the old holders held it for milliseconds. */
const OLD_FILE_MS = 2_000;

/** Test-only: the wait limit, so a test of the error does not wait 35 s. */
export const waitSeam = { limitMs: LOCK_WAIT_MS };

/** The locks this process holds, by path: how deep (a nested withLock on the same file runs at once). */
const held = new Map<string, number>();

/** The error for a wait that ran out: names the lock folder. */
function busy(lock: string): Error {
  return new Error(
    `${lock} has been held for over ${Math.round(waitSeam.limitMs / 1000)} s. If that process is not once-upon, remove the folder.`,
  );
}

/** Runs `work` while this process holds `<file>.lock`, and lets it go after, also when `work` throws. */
export function withLock<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`;
  const depth = held.get(lock) ?? 0;
  let release: (() => void) | null = null;
  if (!depth) {
    ensureDir(path.dirname(file)); // the first write of a fresh home makes it (0700)
    release = lockFolder(file, {
      staleMs: LOCK_STALE_MS,
      waitMs: waitSeam.limitMs,
      leftoverMs: OLD_FILE_MS,
    });
    if (!release) {
      throw busy(lock);
    }
  }
  held.set(lock, depth + 1);
  try {
    return work();
  } finally {
    if (depth) {
      held.set(lock, depth);
    } else {
      held.delete(lock);
      release?.();
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
