/*
 * JSON files in the bridge's home and story folders: read with a fallback,
 * written pretty-printed. Writes go through a temp file and a rename, so a reader (or a
 * crash, or a second writer) never sees half a file.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** The parsed file, or the fallback when it's missing or isn't JSON. */
export function readJson<T = unknown>(file: string, fallback: T | null = null): T | null {
  try {
    // the file's shape is the caller's to check: the bridge wrote it, or a person may have edited it
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes the text through a temp file in the same folder and a rename. The temp name is its own for
 * each write (pid plus random), so writers at the same moment never share one. `mode` is the file's
 * permissions (0o600 for a secret); without one, an existing file keeps the mode it has. The temp
 * is flushed to disk before the rename, so a crash leaves the old file or the new one, not an empty one.
 */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  const temp = tempName(file);
  const want = mode ?? modeOf(file);
  try {
    const handle = openSync(temp, 'wx', want);
    try {
      writeSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (want !== undefined) {
      chmodSync(temp, want); // the umask can narrow the mode openSync was given
    }
    renameSync(temp, file);
  } catch (err) {
    discard(temp);
    throw err;
  }
}

/** Copies a file to `dest` through a temp file and a rename, so a reader never sees half of it. */
export function copyFileAtomic(src: string, dest: string): void {
  const temp = tempName(dest);
  try {
    copyFileSync(src, temp);
    renameSync(temp, dest);
  } catch (err) {
    discard(temp);
    throw err;
  }
}

function tempName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/** The permissions of a file that's there, else undefined (a new file gets the default). */
function modeOf(file: string): number | undefined {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

function discard(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // never made, or already gone
  }
}

/** Writes the value as 2-space indented JSON, atomically. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2), mode);
}
