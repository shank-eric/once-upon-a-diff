/**
 * The facts the Ready doors read for one branch (state/src/queues/backlog/ready.ts): GitHub's answer for the branch, its answer
 * for a PR number an agent typed at finish, and whether the worktree on that branch is pushed. This is the one place the
 * doors look them up, so a stored PR number on the card (stored-card) swaps in here. It reads what the watcher and the scanner
 * already hold: the only ask is `kickInfo` for a typed number, as the Worktrees lane and the Backlog links already ask for
 * branches. When the door knows the commit it reviewed (`reviewed`), a Ready card whose branch tip has moved past it is Working
 * (`working`); that needs the scanner's fact for the branch, so a branch it does not list (checked out in the main checkout, or
 * a repo not discovered yet, or the scanner off) never moves.
 */
import { findTree, type WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import {
  readyFactsOf,
  UNKNOWN_READY,
  type ReadyFacts,
} from '@once-upon-a-diff/state/queues/backlog/ready';
import type { PrWatcher } from './pr-watcher.ts';
import type { Lookups } from './types.ts';

export function readyFactsFor(
  review: PrWatcher,
  branch: { repo: string | null; branch: string | null; typedPr?: number | null },
  trees: WorktreeFacts[],
  nowMs: number,
  reviewed?: { commit: string | null | undefined; movedPast: Lookups['movedPast'] },
): ReadyFacts {
  const { repo, branch: name, typedPr } = branch;
  if (!repo || !name) {
    return UNKNOWN_READY;
  }
  const tree = findTree(trees, repo, name);
  if (typedPr) {
    review.kickInfo(repo, typedPr, nowMs);
  }
  const facts = readyFactsOf({
    branchPr: review.branchPr(repo, name),
    typedPr: typedPr ? review.info(repo, typedPr) : null,
    unpushed: tree?.unpushed,
  });
  const commit = reviewed?.commit?.toLowerCase();
  const tip = tree?.head?.toLowerCase();
  if (!reviewed || !tree || !commit || !tip) {
    return facts;
  }
  const movedPast =
    facts.pr !== 'open' &&
    !tip.startsWith(commit) &&
    reviewed.movedPast(tree.path, commit, tip, tree.defaultBranch);
  return movedPast ? { ...facts, working: true } : facts;
}
