/*
 * The sync lock on a file's `<file>.lock` folder, shared by the store lock (lock.ts) and the usage lock (usage-file.ts): the
 * proper-lockfile package makes the folder (mkdir, so only one process can), judges it stale by its age alone (nothing in it
 * names a holder) and removes it on release. This file adds what the package's sync API lacks, a wait (it refuses `retries`),
 * and clears what an earlier version of once-upon left at the lock path: a lock FILE, or a folder with files in it, which the
 * package would neither judge nor remove (its stale takeover is an `rmdir`).
 *
 * A holder stalled past `staleMs` can lose its lock to another process. Its release then fails (and the release here swallows
 * that) or, since the package removes whatever folder is at the path, takes the new holder's lock with it.
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const STEP_MS = 5;

/** Waits a few milliseconds, blocking this thread: the callers are sync. */
function pause(millis: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis);
}

/**
 * Removes what an earlier version left at the lock path, by its kind, never with a recursive remove (which could delete a fresh
 * lock another process made since it was judged): a file or symlink is unlinked (that fails on a folder made since), a folder
 * with files in it has its files unlinked and is then removed only if it is still the folder judged. An empty folder is the
 * package's own kind of lock and is left alone. Says whether it removed anything.
 */
export function removeLeftover(lock: string): boolean {
  try {
    const seen = lstatSync(lock);
    if (!seen.isDirectory()) {
      unlinkSync(lock);
      return true;
    }
    const names = readdirSync(lock);
    if (names.length === 0) {
      return false;
    }
    for (const name of names) {
      try {
        unlinkSync(path.join(lock, name));
      } catch {
        // gone since: another waiter is clearing it too
      }
    }
    if (lstatSync(lock).ino !== seen.ino) {
      return true; // replaced by another process's new lock while we cleared: it is not ours to remove
    }
    rmdirSync(lock);
    return true;
  } catch {
    return false; // gone since, or not removable (a folder made since): the package's next try says what is wrong
  }
}

/** Removes a leftover once it is over `olderThanMs` old (see removeLeftover). */
export function clearLeftover(lock: string, olderThanMs: number): boolean {
  try {
    if (Date.now() - lstatSync(lock).mtimeMs <= olderThanMs) {
      return false;
    }
  } catch {
    return false; // gone since
  }
  return removeLeftover(lock);
}

/**
 * Takes `<file>.lock`, waiting up to `waitMs` for a holder, and returns the release (which never throws), or null when the
 * wait ran out. Any other trouble throws at once (a folder that cannot be written is not waited for). The file need not
 * exist. `leftoverMs` is how old a lock file or filled folder from an earlier version must be before it is cleared away.
 */
export function lockFolder(
  file: string,
  options: { staleMs: number; waitMs: number; leftoverMs: number },
): (() => void) | null {
  const until = Date.now() + options.waitMs;
  for (;;) {
    try {
      const release = lockfile.lockSync(file, {
        realpath: false,
        stale: options.staleMs,
        onCompromised: () => {}, // nothing to do: the work in hand goes on, and its release lets go of nothing then
      });
      return () => {
        try {
          release();
        } catch {
          // taken over as stale, or already gone: nothing of ours is left to remove
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOCKED' || code === 'ENOTDIR' || code === 'ENOTEMPTY') {
        if (clearLeftover(`${file}.lock`, options.leftoverMs)) {
          continue;
        }
      }
      if (code !== 'ELOCKED') {
        throw error;
      }
    }
    if (Date.now() > until) {
      return null;
    }
    pause(STEP_MS);
  }
}
