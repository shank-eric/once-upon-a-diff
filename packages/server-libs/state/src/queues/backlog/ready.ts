/**
 * Where finished, committed work goes while it waits on you: Ready for your review (not pushed yet), Ready to ship (pushed,
 * GitHub says no PR) or PR open. One pure rule behind the board's three doors: a finished author's own card
 * (board/src/agent-home.ts), an agent parked on `[review]` (stages/agents.ts) and a built backlog card (`cardPhase` row 6).
 * The facts come from GitHub's answer for the branch and the worktree scanner, both already in memory: not asked yet reads as
 * unknown, which keeps each door's column from before. A card that would be Ready for your review while its branch has moved
 * past the commit that was reviewed (a new commit or an amend, board/src/board.ts movedPast) is Working instead: someone is
 * still changing what you were to review.
 */
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import type { BranchPr } from '../../records/github/github-checks.ts';

/** `pr`: GitHub's answer for the branch (`unknown` until it has answered); `pushed`: null when no worktree fact says. */
export interface ReadyFacts {
  pr: 'open' | 'none' | 'unknown';
  pushed: boolean | null;
  /** the branch's tip has moved past the reviewed commit; absent when not known or not asked */
  working?: boolean;
}

export const UNKNOWN_READY: ReadyFacts = { pr: 'unknown', pushed: null };

/**
 * The facts of one branch: GitHub's answer for the branch (`branchPr`: null none, undefined not asked), GitHub's answer for a
 * PR number an agent typed at finish (`typedPr`: null while GitHub has not answered it, so a typo hides nothing), and the
 * scanner's count of commits on no remote ref (`unpushed`: null or undefined with no worktree fact). A PR counts as open only
 * when it is open: a closed one is no PR for the board's columns (it keeps the branch's own answer), and a merged one is left
 * to the merge paths (unknown, so the door keeps its column from before).
 */
export function readyFactsOf(input: {
  branchPr: BranchPr | null | undefined;
  typedPr?: Pick<PrInfo, 'state'> | null;
  unpushed: number | null | undefined;
}): ReadyFacts {
  const { branchPr, typedPr, unpushed } = input;
  const pushed = typeof unpushed === 'number' ? unpushed === 0 : null;
  if (typedPr?.state === 'open' || branchPr?.state === 'open') {
    return { pr: 'open', pushed };
  }
  if (typedPr?.state === 'merged' || branchPr?.state === 'merged') {
    return { pr: 'unknown', pushed };
  }
  return { pr: branchPr === null ? 'none' : 'unknown', pushed };
}

/**
 * The column: an open PR is PR open; a repo that skips review is Ready to ship; pushed with GitHub saying no PR is Ready to
 * ship, with or without an approval; anything else (unpushed, or not known) is Ready for your review, or Working when
 * the branch has moved past what was reviewed (`working`).
 */
export function readyColumn(
  facts: ReadyFacts,
  skipsReview = false,
): 'pr_open' | 'ship' | 'ready' | 'working' {
  if (facts.pr === 'open') {
    return 'pr_open';
  }
  if (skipsReview || (facts.pr === 'none' && facts.pushed === true)) {
    return 'ship';
  }
  return facts.working ? 'working' : 'ready';
}
