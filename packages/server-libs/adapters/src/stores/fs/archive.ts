/*
 * The archive of the compacted logs: `<home>/archive/<store>-YYYY-MM.jsonl`, one file a month of the rows `once-upon compact`
 * took out of agents.jsonl and backlog.jsonl. The board never reads it; `card status` does. A row is written here before the
 * log is swapped, so a crash in between duplicates rows and never loses one: a row already in the month's file is not written
 * again, and a reader takes each line once.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendText, ensureDir } from './files.ts';
import { withLock } from './lock.ts';

export const archiveDir = (home: string) => path.join(home, 'archive');

/** The `YYYY-MM` of an ISO time, or null when it is not one. */
export function monthOf(time: string | undefined): string | null {
  return time !== undefined && /^\d{4}-\d{2}/.test(time) ? time.slice(0, 7) : null;
}

/** Appends each row to its month's file of the store (a row already there is skipped). Returns how many rows were written. */
export function appendArchive(
  home: string,
  store: string,
  entries: { month: string; line: string }[],
): number {
  const months = new Map<string, string[]>();
  for (const { month, line } of entries) {
    months.set(month, [...(months.get(month) ?? []), line]);
  }
  let written = 0;
  for (const [month, lines] of months) {
    ensureDir(archiveDir(home));
    const file = path.join(archiveDir(home), `${store}-${month}.jsonl`);
    withLock(file, () => {
      const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []);
      const fresh = lines.filter((line) => !have.has(line));
      if (fresh.length) {
        appendText(file, fresh.map((line) => line + '\n').join(''), 0o600);
        written += fresh.length;
      }
    });
  }
  return written;
}

/** Every archived row of the store in log order (by each row's own `at`, ties and rows with none in file order), each line once ('' when there is none). */
export function readArchive(home: string, store: string): string {
  const dir = archiveDir(home);
  if (!existsSync(dir)) {
    return '';
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  const names = readdirSync(dir)
    .filter((name) => new RegExp(`^${store}-\\d{4}-\\d{2}\\.jsonl$`).test(name))
    .sort();
  for (const name of names) {
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  const time = (line: string) => {
    try {
      const when = Date.parse((JSON.parse(line) as { at?: string }).at ?? '');
      return Number.isNaN(when) ? -8.64e15 : when;
    } catch {
      return -8.64e15;
    }
  };
  const stamped = lines.map((line) => ({ line, when: time(line) }));
  stamped.sort((one, other) => one.when - other.when);
  return stamped.map(({ line }) => line + '\n').join('');
}
