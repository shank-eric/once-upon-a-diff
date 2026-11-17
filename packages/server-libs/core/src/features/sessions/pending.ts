/**
 * A queued Start listening, for a session nothing can type into (no iTerm tab: another terminal, the Desktop Code tab): the
 * bridge writes `<home>/pending-listen/<key>.json`, and the hook (`extras/hooks/listen-pending.sh`) hands it to the next
 * session you use in that repo's checkout, which is told to run the /once-upon-listen skill. The request is made here from
 * a validated repo or story, so nothing the page sent is stored but that; it lapses after 15 minutes.
 */
import { listeners } from '@once-upon-a-diff/state/records/listeners/listeners';
import {
  readPendingListen,
  type PendingListen,
} from '@once-upon-a-diff/contracts/files/pending-listen';
import { pendingListenKey } from '@once-upon-a-diff/terms/ids';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import {
  readPendingFiles,
  removePending,
  sweepClaimed,
  writePending,
} from '@once-upon-a-diff/adapters/claude-sessions/pending-listen';
import { BoardError } from '@once-upon-a-diff/foundation/errors';

/** How long a queued request waits for a session. */
export const PENDING_LISTEN_MS = 15 * 60 * 1000;

/** What a request is for: a repo's listener, or one story's (its repo, else its checkout, say where the session is). */
export interface PendingTarget {
  repo: string | null;
  story: string | null;
  checkout: string | null;
}

/** Drops the requests that have lapsed, those the file's format does not accept, and the hook's leftovers. */
export function sweepPendingListens(home: string, now = Date.now()): void {
  for (const { key, text } of readPendingFiles(home)) {
    let parsed: PendingListen | null = null;
    try {
      parsed = readPendingListen(JSON.parse(text));
    } catch {
      /* not JSON */
    }
    if (!parsed || parsed.expires <= now) {
      removePending(home, key);
    }
  }
  sweepClaimed(home, PENDING_LISTEN_MS, now);
}

/**
 * Queues the request for `target`, refreshing the one already queued, and answers its key and expiry. A target that already
 * has a live listener is a 409 (the skill would only say "already listening"): a repo's listener covers a repo target, a
 * catch-all one covers every repo, and a story's own listener covers a story target.
 */
export function queueListen(
  home: string,
  target: PendingTarget,
  now = Date.now(),
): { key: string; expires: number } {
  const covered = listeners(home, now).some(
    (one) =>
      one.live &&
      (target.story
        ? one.story === target.story
        : !one.story && (!one.repo || (target.repo && sameRepo(one.repo, target.repo)))),
  );
  if (covered) {
    throw new BoardError(409, 'a session is already listening for that');
  }
  sweepPendingListens(home, now);
  const key = pendingListenKey(target);
  const expires = now + PENDING_LISTEN_MS;
  const entry: PendingListen = { v: 1, key, ...target, at: now, expires };
  writePending(home, key, JSON.stringify(entry));
  return { key, expires };
}
