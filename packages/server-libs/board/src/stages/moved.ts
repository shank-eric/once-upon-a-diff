/**
 * The cards whose branch has moved past what you were to review. A work card with a local story and no PR, not approved and
 * not reviewed, is Ready for your review; if its branch's worktree tip is now a later commit, or an amend, of the commit the
 * story was told over (`told_head_oid`), someone is still changing the work, so the card is Working (columns.ts `moved`).
 * A pure rebase (the same patch on a moved main) has not moved, and a retell puts the told commit back at the tip.
 *
 * The tip is the worktree scanner's fact for the repo and branch (memory only), so a branch the scanner does not list (checked
 * out in the main checkout, a repo it has not found yet, the scanner off) never moves. The git look is Lookups.movedPast: in the
 * background, null until it answers, which leaves the card where it was.
 */
import { findTree, type WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { couldBeReady } from '../columns.ts';
import type { Lookups } from './types.ts';

export function movedCards(
  cards: BoardCard[],
  toldHeads: Map<string, string>,
  trees: WorktreeFacts[],
  movedPast: Lookups['movedPast'],
): Set<BoardCard> {
  const moved = new Set<BoardCard>();
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
      moved.add(card);
    }
  }
  return moved;
}
