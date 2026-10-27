/**
 * Which repos have had a listener lately, for the board's Listeners lane: <home>/listener-history.json,
 * {<owner/name lowercased>: {repo, consumer, started_at, last_seen}}. `once-upon wait --repo` notes itself when it starts,
 * and the board refreshes the entry of every repo with a live listener when it builds. `started_at` is when the repo went
 * from no listener to one, so the lane can say how long it has been listening. Entries older than HISTORY_DAYS are dropped.
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/json-file.ts';

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
 * A listener for the repo is live now. `gapMs` is how long without one still counts as the same stretch (a wait ends and
 * the session starts the next within seconds), so `started_at` only moves when the repo really had none.
 */
export function noteListener(
  home: string,
  repo: string,
  consumer: string,
  now = Date.now(),
  gapMs = 60 * 1000,
): void {
  const all = readHistory(home, now);
  const key = repo.toLowerCase();
  const before = all[key];
  if (before && before.consumer === consumer && now - Date.parse(before.last_seen) < 20 * 1000) {
    return; // noted a moment ago: the board asks every few seconds
  }
  const continuing = before && now - Date.parse(before.last_seen) < gapMs;
  all[key] = {
    repo,
    consumer,
    started_at: continuing ? before.started_at : new Date(now).toISOString(),
    last_seen: new Date(now).toISOString(),
  };
  try {
    writeJsonAtomic(file(home), all);
  } catch {
    /* the history is a convenience */
  }
}
