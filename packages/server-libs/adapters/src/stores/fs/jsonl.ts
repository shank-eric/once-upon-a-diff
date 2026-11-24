/*
 * An append-only JSONL log: one JSON value a line, appended and never rewritten, so the CLI (in-process) and the bridge
 * can both write without a lock. agents.jsonl and backlog.jsonl are built on it; what the lines mean, and how they fold,
 * is each store's service's.
 */
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ensureDir } from './files.ts';
import { appendLine } from './lines.ts';
import { withLock } from './lock.ts';

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

/** Where the old log is kept: `<file>.<yyyymmdd>.bak`, or `.<yyyymmdd>-2.bak` and on when that day's is already there. */
function backupName(file: string, now: Date): string {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  let name = `${file}.${day}.bak`;
  for (let copy = 2; existsSync(name); copy++) {
    name = `${file}.${day}-${copy}.bak`;
  }
  return name;
}

/** Removes the other `<file>.<yyyymmdd>[-n].bak` copies of the log, so that `keep` is the one left. */
function pruneBackups(file: string, keep: string): void {
  const prefix = `${path.basename(file)}.`;
  for (const name of readdirSync(path.dirname(file))) {
    const old = path.join(path.dirname(file), name);
    if (
      old !== keep &&
      name.startsWith(prefix) &&
      /^\d{8}(-\d+)?\.bak$/.test(name.slice(prefix.length))
    ) {
      unlinkSync(old);
    }
  }
}

/**
 * Replaces a log with a rewrite of it, and keeps the old one. Under the file's lock it hands `rewrite` the log's whole lines
 * (a last line with no newline yet is carried over as it is), writes what `rewrite` returns beside the log, copies on any bytes
 * appended while it worked, links the old file as `<file>.<yyyymmdd>.bak` and renames the new one over it. Appends take no lock
 * (the file is append-only), so one that lands after the last size check goes into the old inode: after the rename the old
 * file is read again from what was copied and the rest is appended to the new log, until nothing new arrives (the old log is
 * kept all the same). A reader that tails the log sees a different file and starts over. `rewrite` returning null leaves the
 * log alone. `beforeSwap` runs just before the last size check (tests append there; a caller that keeps offsets into the log
 * moves them there), `beforeRename` between the link and the rename (a test's append that lands in the old file).
 * `keepBackups: 1` removes the older `.bak` copies of this log once the new one is linked, so the latest is the only one.
 */
export function replaceLog(
  file: string,
  rewrite: (whole: string) => string | null,
  {
    now = new Date(),
    beforeSwap,
    beforeRename,
    keepBackups,
  }: {
    now?: Date;
    beforeSwap?: () => void;
    beforeRename?: () => void;
    keepBackups?: 1;
  } = {},
): { before: number; after: number; kept: string } | null {
  return withLock(file, () => {
    if (!existsSync(file)) {
      return null;
    }
    const old = readFileSync(file);
    const cut = old.lastIndexOf(0x0a) + 1;
    const next = rewrite(old.subarray(0, cut).toString('utf8'));
    if (next === null) {
      return null;
    }
    const fresh = `${file}.new-${process.pid}`;
    writeFileSync(fresh, Buffer.concat([Buffer.from(next, 'utf8'), old.subarray(cut)]), {
      mode: 0o600,
    });
    beforeSwap?.();
    const grown = readLogFrom(file, old.length);
    if (grown.length) {
      writeFileSync(fresh, grown, { flag: 'a' });
    }
    const kept = backupName(file, now);
    linkSync(file, kept);
    if (keepBackups) {
      pruneBackups(file, kept);
    }
    beforeRename?.();
    renameSync(fresh, file);
    // an unlocked append that landed after the read above (or whose writer opened the old path just before the rename) went
    // into the old inode, which `kept` now names: carry it over until nothing new arrives
    let copied = old.length + grown.length;
    for (let tail = readLogFrom(kept, copied); tail.length; tail = readLogFrom(kept, copied)) {
      writeFileSync(file, tail, { flag: 'a' });
      copied += tail.length;
    }
    return { before: copied, after: statSync(file).size, kept };
  });
}
