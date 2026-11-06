/*
 * The story tags' poll (a createPoll), for pr-tags.ts: while a story is queued, building or updating it says "some PRs are due
 * a look" every 10 s, and every 30 s while the bridge doesn't answer, while the tab shows and when it gets focus. It is idle
 * (no timer) otherwise; the tags call `reschedule` when a look or a click changes which of those it is.
 */
import { createPoll } from '@once-upon-a-diff/bridge-client/poll';
import { prKey } from '@once-upon-a-diff/terms/ids';
import type { PrRef, StoryStatus } from './tag-model.ts';

export const LOOK_AGAIN_MS = 10000; // while a story is queued, building or updating
export const OFFLINE_MS = 30000; // while the bridge doesn't answer

export const inFlight = (result: StoryStatus | null) =>
  !!result && (result.state === 'queued' || result.state === 'building' || !!result.updating);

/**
 * The PRs the poll looks up again: the ones in flight, or all of them while the bridge is down. `scope` is the PRs the page
 * is on (a page that shows one PR); without it, every PR the tags have an answer for (a list). A PR the page has left is never due.
 */
export function pollTargets(
  results: Map<string, StoryStatus>,
  failed: boolean,
  scope: PrRef[] | null,
): PrRef[] {
  // (status-many's lines carry repo and number; a line a click set does not, and keys as undefined#undefined)
  const prs = scope ?? ([...results.values()] as PrRef[]);
  return failed
    ? prs
    : prs.filter((pr) => inFlight(results.get(prKey(pr.repo, pr.number)) ?? null));
}

export function createTagPoll({
  failed,
  waiting,
  alive,
  onDue,
}: {
  /** The bridge didn't answer the last look (it sets the wait: 30 s, not 10). */
  failed: () => boolean;
  /** The PRs to look up again: the ones in flight, or all of them while the bridge is down. */
  waiting: () => PrRef[];
  /** false once the extension was reloaded under the page. */
  alive: () => boolean;
  /** `signal` is the poll's load's: pass it to the calls the look makes (it is aborted when the load times out). */
  onDue: (prs: PrRef[], signal: AbortSignal) => void | Promise<void>;
}) {
  return createPoll<void>({
    everyMs: () => {
      if (!waiting().length) {
        return null;
      }
      return failed() ? OFFLINE_MS : LOOK_AGAIN_MS;
    },
    load: async (signal) => {
      const prs = waiting();
      if (alive() && prs.length) {
        await onDue(prs, signal);
      }
    },
    onChange: () => {},
  });
}
