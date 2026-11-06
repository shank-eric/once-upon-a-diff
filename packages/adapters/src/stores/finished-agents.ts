/*
 * <home>/finished-agents.json: the agents whose card Finish cleared on the board, by `<sid>:<name>`, with the time of the
 * click (ms). The board hides a finished agent's card while nothing it did is later than that time, so a new event
 * or beat brings it back. Writes go through readJson and writeFileAtomic.
 */
import path from 'node:path';
import { ensureDir } from './fs/files.ts';
import { readJson, writeJsonAtomic } from './fs/json-file.ts';

const file = (home: string) => path.join(home, 'finished-agents.json');

/**
 * Entries this old are dropped on the next write, long after any card they could hide has gone. A finished author waiting
 * on your review (agent-home.ts pendingReview) stops waiting this long after its last activity, so its Finish outlives it.
 */
export const KEEP_MS = 7 * 24 * 3600 * 1000;

/** When each cleared agent's card was cleared, in ms, by `<sid>:<name>`. */
export function readFinished(home: string): Map<string, number> {
  const stored = readJson<Record<string, unknown>>(file(home), {}) ?? {};
  return new Map(
    Object.entries(stored).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/** Records that the agent's card was cleared at `when` (ms), and forgets entries older than a week. */
export function markFinished(home: string, key: string, when: number): void {
  const kept = [...readFinished(home)].filter(([, clearedAt]) => when - clearedAt < KEEP_MS);
  ensureDir(home);
  writeJsonAtomic(file(home), Object.fromEntries([...kept, [key, when]]));
}
