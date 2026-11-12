/**
 * A fixer's commit carries the approval. Approving a local story names the head it approved, and a new commit clears
 * that, so a fixer run's commit (a fix round after the approval) would send the card back to Ready for your review. When a
 * fixer's run on the card finishes `--commit` at the tip of the story's branch, the approval moves to that commit, with
 * `carried` recording where it came from. The approval is the one you gave: `at` stays, so APPROVED_DAYS counts from it.
 *
 * It carries only when all hold: the run's role is `fixer` (the start row keeps it; an older run has none and never
 * carries), it is done, it names a card with a branch and repo, that card's newest local story has an approval
 * (current, or `lapsed` because the background check saw the new tip first) under APPROVED_DAYS, and the commit is the
 * tip of the ref the story follows and not the commit approved, with the approved commit behind it and every commit
 * between them made since the run started (a commit by someone else, or a rebase, is not the fixer's to carry). An undone
 * approval is gone, so there is nothing to carry. A story pinned to the commits it was told over (`--head <branch>`) keeps
 * its head, so `carried.from` is the first approved commit: `approvalOf` counts the approval for the story at that head too.
 */
import { commitLog, commitOf, isAncestor } from '@once-upon-a-diff/adapters/git';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readMeta } from '@once-upon-a-diff/stories/meta';
import { refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import { APPROVAL_FILE, approvalFresh, readApproval } from '@once-upon-a-diff/stories/approval';
import type { Approval } from '@once-upon-a-diff/stories/approval';
import type { LocalMeta } from '@once-upon-a-diff/stories/types';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { localEntries, markStoryReviewed } from './story-lists.ts';

/** Carries the approval of the finished fixer run's story to its commit; returns where from and to, or null when nothing carried. */
export function carryApproval(
  home: string,
  run: LedgerAgent,
  now = Date.now(),
): { from: string; to: string } | null {
  const commit = run.result?.commit;
  if (run.role !== 'fixer' || run.state !== 'done' || !run.card || !commit) {
    return null;
  }
  // an implicit card (ADR-27) has no backlog row: the run's own repo and branch are the card's
  const found = new BacklogStore(home).items().find((one) => one.id === run.card);
  const item = found ?? { repo: run.repo, branch: run.branch, state: 'started' };
  if (!item.branch || !item.repo || item.state === 'dropped') {
    return null;
  }
  const stories = new StoryStore({ home });
  const entry = localEntries(stories, { now }).find(
    (one) => one.story.branch === item.branch && sameRepo(one.story.repo, item.repo),
  );
  const approval = entry && readApproval(stories, entry.story.id);
  if (!entry?.repo_path || !entry.head_ref || !approval || !approvalFresh(approval, now)) {
    return null;
  }
  const tip = commitOf(entry.repo_path, entry.head_ref);
  if (!tip || tip !== commitOf(entry.repo_path, commit) || tip === approval.head_oid) {
    return null;
  }
  // only what the fixer's run committed: the approved commit is behind the tip, and nothing between was made before the run
  const since = Math.floor((run.started?.getTime() ?? Infinity) / 1000) * 1000;
  const made = commitLog(entry.repo_path, [`${approval.head_oid}..${tip}`]);
  if (
    !isAncestor(entry.repo_path, approval.head_oid, tip) ||
    !made.length ||
    made.some((one) => !(Date.parse(one.at) >= since))
  ) {
    return null;
  }
  const id = entry.story.id;
  const dir = stories.dirOf(id);
  // the story follows its checkout, so its head moves to the commit now rather than on the next page poll
  const meta = dir ? refreshLocal(dir, readMeta(dir) as LocalMeta) : null;
  const { lapsed: _lapsed, ...kept } = approval;
  stories.writeState(id, APPROVAL_FILE, {
    ...kept,
    head_oid: tip,
    base_oid: meta?.base_oid ?? approval.base_oid,
    carried: {
      from: approval.carried?.from ?? approval.head_oid,
      at: new Date(now).toISOString(),
      run: run.run ?? '',
    },
  } satisfies Approval);
  // the lapse took the mark approving wrote: it comes back with the approval
  const mark = stories.readState<{ at?: string | null } | null>(id, 'reviewed.json', null);
  if (approval.marked && !mark?.at) {
    markStoryReviewed(stories, id, true, 'approved');
  }
  return { from: approval.head_oid, to: tip };
}
