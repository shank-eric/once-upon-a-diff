import type { LocalEntry } from '../../../features/review/story-lists.ts';
import type { BranchPr } from '../../../records/github/github-checks.ts';
import type { InboxStory, PrInfo } from '@once-upon-a-diff/contracts/types';

/** What the board asks of the GitHub watcher (review/github-watcher.ts's AutoReview): it reads what it has and never waits. */
export interface PrWatcher {
  kick(stories: InboxStory[]): void;
  kickInfo(repo: string, number: number): void;
  kickBranch(repo: string, branch: string, checkout: string, now?: number, heads?: string[]): void;
  kickLocal(list: LocalEntry[]): void;
  kickRequested(): void;
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
