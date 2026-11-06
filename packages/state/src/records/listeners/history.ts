/**
 * Which repos have had a listener lately, for the board's Listeners lane: <home>/listener-history.json,
 * {<owner/name lowercased>: {repo, consumer, started_at, last_seen}}. a repo-wide listener's heartbeat (listeners.ts `beat`, and
 * `touchHandling` while a session works on what it handed over) notes its repo. `started_at` is when the repo went
 * from no listener to one, so the lane can say how long it has been listening. The board only reads this file. Entries older than HISTORY_DAYS are dropped.
 */
import { repoKey } from '@once-upon-a-diff/domain/ids';
import path from 'node:path';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson } from '@once-upon-a-diff/adapters/stores/fs/lock';

export const HISTORY_DAYS = 7;

export interface HistoryEntry {
  repo: string;
  consumer: string;
  started_at: string;
  last_seen: string;
}
export type History = Record<string, HistoryEntry>;

const file = (home: string) => path.join(home, 'listener-history.json');

/** The remembered repos, the recent ones only. */
export function readHistory(home: string, now = Date.now()): History {
  const all = readJson<History>(file(home), {}) || {};
  const kept: History = {};
  for (const [key, entry] of Object.entries(all)) {
    if (entry && now - Date.parse(entry.last_seen) < HISTORY_DAYS * 24 * 3600 * 1000) {
      kept[key] = entry;
    }
  }
  return kept;
}

/**
 * A listener for the repo is live now. `gapMs` is how long without a note still counts as the same stretch, so `started_at`
 * only moves when the repo really had no listener: a heartbeat passes more than a handover can take (listeners.ts), since
 * nothing notes the repo while a session works on what its wait handed it. The read, change and write are under the file's
 * lock, so two listeners noting at once lose nothing.
 */
export function noteListener(
  home: string,
  repo: string,
  consumer: string,
  now = Date.now(),
  gapMs = 60 * 1000,
): void {
  const key = repoKey(repo);
  try {
    updateJson(file(home), {} as History, (all) => {
      for (const [name, entry] of Object.entries(all)) {
        if (!entry || now - Date.parse(entry.last_seen) >= HISTORY_DAYS * 24 * 3600 * 1000) {
          delete all[name];
        }
      }
      const before = all[key];
      if (
        before &&
        before.consumer === consumer &&
        now - Date.parse(before.last_seen) < 20 * 1000
      ) {
        return; // noted a moment ago: a heartbeat comes every few seconds
      }
      const continuing = before && now - Date.parse(before.last_seen) < gapMs;
      all[key] = {
        repo,
        consumer,
        started_at: continuing ? before.started_at : new Date(now).toISOString(),
        last_seen: new Date(now).toISOString(),
      };
    });
  } catch {
    /* the history is a convenience */
  }
}
