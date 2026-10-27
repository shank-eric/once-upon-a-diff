/*
 * Picking a default among sessions for the board's Start listening: the most recently active one when it is the obvious
 * choice. No DOM or Node dependencies.
 */

/** A session that Start listening could use: how long ago it last changed state decides which is freshest. */
export interface Candidate {
  id: string;
  /** ISO time it entered its idle or done status; null when unknown */
  since: string | null;
}

/** How much fresher the best session has to be than the next one for the choice to be obvious. */
export const OBVIOUS_MS = 5 * 60 * 1000;

const timeOf = (candidate: Candidate) => (candidate.since ? Date.parse(candidate.since) : 0) || 0;

/** The candidates, most recently active first (ties and unknown times keep their order). */
export function freshestFirst<T extends Candidate>(candidates: readonly T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (first, second) =>
        timeOf(second.candidate) - timeOf(first.candidate) || first.index - second.index,
    )
    .map((entry) => entry.candidate);
}

/**
 * The session to use without asking: the only candidate, or the freshest one when it is at least OBVIOUS_MS fresher than the
 * next. Null when there is none, or several close together (the page then asks).
 */
export function obviousChoice<T extends Candidate>(candidates: readonly T[]): T | null {
  const ordered = freshestFirst(candidates);
  if (ordered.length <= 1) {
    return ordered[0] ?? null;
  }
  const [best, next] = ordered;
  return timeOf(best) && timeOf(best) - timeOf(next) >= OBVIOUS_MS ? best : null;
}
