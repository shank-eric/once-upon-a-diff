/**
 * The cards whose branch has moved past what you were to review. A work card with a local story and no PR, not approved and
 * not reviewed, is Ready for your review; if its branch's worktree tip is now a later commit, or an amend, of the commit the
 * story was told over (`told_head_oid`), someone is still changing the work, so the card is Working (columns.ts `moved`).
 * A pure rebase (the same patch on a moved main) has not moved, and a retell puts the told commit back at the tip.
 *
 * Whether a run accounts for the new tip (`coveringRun`) sets the card's label: none is "changed outside a run" (a listener edited in
 * place, or someone committed by hand) and the card gets `outside`, which Record as fix turns into a fixer run; a finished fixer run
 * with the tip as its commit says the fix is recorded and the story only needs retelling; one still going is the plain move.
 * The same label is on the finished-author and built-backlog rules (agent-home.ts `pendingReview`, ready-facts.ts).
 *
 * The tip is the worktree scanner's fact for the repo and branch (memory only), so a branch the scanner does not list (checked
 * out in the main checkout, a repo it has not found yet, the scanner off) never moves. The git look is Lookups.movedPast: in the
 * background, null until it answers, which leaves the card where it was.
 */
import { coveringRun, runsOnBranch } from '@once-upon-a-diff/state/queues/backlog/phase';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { findTree, type WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { couldBeReady } from '../columns.ts';
import type { Lookups } from './types.ts';

/** A card whose branch moved: the tip and its worktree, and the work run that accounts for the tip (null: it moved outside every run). */
export interface Moved {
  tip: string;
  path: string;
  covering: LedgerAgent | null;
}

export function movedCards(
  cards: BoardCard[],
  toldHeads: Map<string, string>,
  trees: WorktreeFacts[],
  movedPast: Lookups['movedPast'],
  agents: LedgerAgent[] = [],
  nowMs: number = Date.now(),
): Map<BoardCard, Moved> {
  const moved = new Map<BoardCard, Moved>();
  for (const card of cards) {
    // only a card that could be Ready (columns.ts)
    if (!couldBeReady(card)) {
      continue;
    }
    const { story, repo, branch } = card;
    const told = toldHeads.get(story.id)?.toLowerCase();
    const tree = findTree(trees, repo, branch);
    const tip = tree?.head?.toLowerCase();
    if (
      tree &&
      told &&
      tip &&
      told !== tip &&
      movedPast(tree.path, told, tip, tree.defaultBranch)
    ) {
      moved.set(card, {
        tip,
        path: tree.path,
        covering: coveringRun(runsOnBranch(agents, repo, branch), tip, nowMs),
      });
    }
  }
  return moved;
}
