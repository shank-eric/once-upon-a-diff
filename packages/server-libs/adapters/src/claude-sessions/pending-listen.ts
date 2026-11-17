/**
 * The queued Start listening requests the hook claims: `<home>/pending-listen/<key>.json`, one per target, written whole
 * (tmp + rename) so the hook never reads half of one and a second click just refreshes it. The format is
 * `PendingListenSchema` (contracts/src/files/pending-listen.ts); this module only moves the files. The hook
 * (`extras/hooks/listen-pending.sh`) claims one by renaming it into `claimed/` and removes it at once, so `claimed/` only
 * holds a crash's leftovers, which `sweepClaimed` clears.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, removeFile, writeText } from '../stores/fs/files.ts';

const DIR = 'pending-listen';
const KEY_RE = /^(repo|story)-[A-Za-z0-9._-]+$/;

const dirOf = (home: string) => path.join(home, DIR);

/** Writes the request for `key` whole, owner-only. A key that is not `repo-...` or `story-...` is refused (it names a file). */
export function writePending(home: string, key: string, text: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`not a pending-listen key: ${key}`);
  }
  const dir = dirOf(home);
  ensureDir(dir, 0o700);
  const file = path.join(dir, `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeText(tmp, text, 0o600);
  renameSync(tmp, file);
}

/** Every request file's key and text (a file that cannot be read is left out). */
export function readPendingFiles(home: string): { key: string; text: string }[] {
  const dir = dirOf(home);
  if (!existsSync(dir)) {
    return [];
  }
  const found: { key: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const key = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!KEY_RE.test(key)) {
      continue;
    }
    try {
      found.push({ key, text: readFileSync(path.join(dir, name), 'utf8') });
    } catch {
      /* gone since the listing */
    }
  }
  return found;
}

/** Removes one request. */
export function removePending(home: string, key: string): void {
  if (KEY_RE.test(key)) {
    removeFile(path.join(dirOf(home), `${key}.json`));
  }
}

/** Removes every request whose key `covered` accepts (a listener that started makes the requests it covers moot). */
export function removePendingWhere(home: string, covered: (key: string) => boolean): void {
  for (const { key } of readPendingFiles(home)) {
    if (covered(key)) {
      removePending(home, key);
    }
  }
}

/** Removes what the hook's claim left behind (`claimed/*`) once it is older than `olderThanMs`. */
export function sweepClaimed(home: string, olderThanMs: number, now = Date.now()): void {
  const dir = path.join(dirOf(home), 'claimed');
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    try {
      if (now - statSync(path.join(dir, name)).mtimeMs > olderThanMs) {
        removeFile(path.join(dir, name));
      }
    } catch {
      /* gone since the listing */
    }
  }
}
