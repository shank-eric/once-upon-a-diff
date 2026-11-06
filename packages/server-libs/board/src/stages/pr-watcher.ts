import type { LocalEntry } from '@once-upon-a-diff/core/features/review/story-lists';
import type { BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import type { InboxStory, PrInfo } from '@once-upon-a-diff/contracts/types';

/**
 * What the board asks of the GitHub watcher (review/github-watcher.ts's AutoReview): it reads what it has and never waits.
 * Every kick takes the caller's clock (the board's `nowMs`), so a board on a fake clock never stamps an ask on the real one.
 */
export interface PrWatcher {
  kick(stories: InboxStory[], now: number): void;
  kickInfo(repo: string, number: number, now: number): void;
  kickBranch(repo: string, branch: string, checkout: string, now: number, heads?: string[]): void;
  kickLocal(list: LocalEntry[], now: number): void;
  kickRequested(now: number): void;
  requested(): { repo: string; number: number }[];
  info(repo: string, number: number): PrInfo | null;
  branchPr(repo: string, branch: string): BranchPr | null | undefined;
}

/** A watcher that knows nothing (the CLI's one-off count, which has no cache to read). */
export const noPrWatcher: PrWatcher = {
  kick: () => undefined,
  kickInfo: () => undefined,
  kickBranch: () => undefined,
  kickLocal: () => undefined,
  kickRequested: () => undefined,
  requested: () => [],
  info: () => null,
  branchPr: () => undefined,
};
