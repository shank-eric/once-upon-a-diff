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
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import type { WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import type { Lookups } from './types.ts';

export function movedCards(
  cards: BoardCard[],
  toldHeads: Map<string, string>,
  trees: WorktreeFacts[],
  movedPast: Lookups['movedPast'],
): Set<BoardCard> {
  const moved = new Set<BoardCard>();
  for (const card of cards) {
    const { story, repo, branch } = card;
    // only a card that could be Ready: a local story, no PR, not landed, not approved (that is Ready to ship), not reviewed
    if (
      card.kind === 'agent' ||
      story?.kind !== 'local' ||
      card.pr ||
      card.landed ||
      story.approved_at ||
      (story.reviewed && !story.unread_answers) ||
      !repo ||
      !branch
    ) {
      continue;
    }
    const told = toldHeads.get(story.id)?.toLowerCase();
    const tree = trees.find(
      (one) => !!one.repo && sameRepo(one.repo, repo) && one.branch === branch,
    );
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
