/*
 * An append-only JSONL log: one JSON value a line, appended and never rewritten, so the CLI (in-process) and the bridge
 * can both write without a lock. agents.jsonl and backlog.jsonl are built on it; what the lines mean, and how they fold,
 * is each store's service's.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { ensureDir } from './files.ts';
import { appendLine } from './lines.ts';

/** The log's text, or '' when there is no file yet. */
export function readLogText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Appends one value as a line, starting a new line first when the file doesn't end with one. The file is the user's alone (0600). */
export function appendLogLine(file: string, value: unknown): void {
  ensureDir(path.dirname(file)); // the first event of a fresh home makes it (0700)
  appendLine(file, JSON.stringify(value), 0o600);
}

/** The values in a log's text, oldest first. A line that isn't JSON (blank, half-written, hand-edited) is skipped; what each value must look like is the caller's to check. */
export function jsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split('\n')) {
    try {
      values.push(JSON.parse(line));
    } catch {
      // not a value: skipped
    }
  }
  return values;
}

/** An append-only log's identity and length (its inode changes when the file is replaced), or null when there is no file. */
export function logState(file: string): { ino: number; size: number } | null {
  try {
    const { ino, size } = statSync(file);
    return { ino, size };
  } catch {
    return null;
  }
}

/** The first `count` bytes of the log (fewer when it is shorter). */
export function readLogHead(file: string, count: number): Buffer {
  const handle = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(count);
    return bytes.subarray(0, readSync(handle, bytes, 0, count, 0));
  } finally {
    closeSync(handle);
  }
}

/** The bytes of the log from `from` to its end, for a reader that has already taken what is before. */
export function readLogFrom(file: string, from: number): Buffer {
  const handle = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const bytes = Buffer.alloc(Math.max(0, size - from));
    readSync(handle, bytes, 0, bytes.length, from);
    return bytes;
  } finally {
    closeSync(handle);
  }
}
