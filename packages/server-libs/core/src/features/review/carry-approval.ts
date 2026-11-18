/**
 * A fixer's commit, or its rebase, carries the approval. Approving a local story names the head it approved, and a new
 * commit or a rebase changes that, so a fixer run's commit (a fix round after the approval) or its rebase onto a moved
 * main would send the card back to Ready for your review. When a fixer's run on the card finishes `--commit` at the tip of
 * the story's branch, the approval moves to that commit, with `carried` recording where it came from (`via: 'rebase'`
 * when it was a rebase). The approval is the one you gave: `at` stays, so APPROVED_DAYS counts from it.
 *
 * It carries only when all hold: the run's role is `fixer` (the start row keeps it; an older run has none and never
 * carries), it is done, it names a card with a branch and repo, that card's newest local story has an approval
 * (current, or `lapsed` because the background check saw the new tip first) under APPROVED_DAYS, and the commit is the
 * tip of the ref the story follows and not the commit approved, and one of these:
 * - a fix: the approved commit is behind the tip and every commit between them was made since the run started (a commit
 *   by someone else is not the fixer's to carry);
 * - a rebase: the approved commit is not behind the tip, and the commits from the tip's new base (its merge-base with the
 *   story's base ref: the `base` the story was told over when that is a branch or ref, else origin's default branch or
 *   main/master) to the tip, all made since the run started, are the approved commits (those between the approval's
 *   `base_oid` and its `head_oid`) one for one, in order: the same `git patch-id --stable` for each, or, when a conflict
 *   was resolved and a patch-id differs, the same number of commits with the same subjects. A rebase that drops, adds or
 *   rewords a commit carries nothing. A branch stacked on another unlanded branch has its own commits at the top of the
 *   tip, whatever lies under them: the approved count of commits below the tip counts as the new base too.
 * An undone approval is gone, so there is nothing to carry. A story pinned to the commits it was told over
 * (`--head <branch>`) keeps its head, so `carried.from` is the first approved commit: `approvalOf` counts the approval
 * for the story at that head too.
 */
import {
  commitLog,
  commitOf,
  defaultBranchOf,
  isAncestor,
  mergeBase,
  patchId,
  revParse,
} from '@once-upon-a-diff/adapters/git';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readMeta } from '@once-upon-a-diff/stories/meta';
import { movedSince, refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import { approvalFresh, readApproval } from '@once-upon-a-diff/stories/approval';
import type { LocalMeta } from '@once-upon-a-diff/stories/types';
import type { LocalCommit } from '@once-upon-a-diff/contracts/types';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { localEntries } from './story-lists.ts';
import { updateReviewRecord } from './review-record.ts';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** The refs the story's base may now be called by: the `base` it was told over when that is a ref (not a sha), origin's default branch, local main or master. */
function baseRefs(repo: string, told: string | undefined): string[] {
  const remote = defaultBranchOf(repo);
  return [
    ...(told && !SHA_RE.test(told) ? [told] : []),
    ...(remote ? [`refs/remotes/origin/${remote}`] : []),
    'refs/heads/main',
    'refs/heads/master',
  ];
}

const patchIdOr = (repo: string, sha: string): string | null => {
  try {
    return patchId(repo, sha);
  } catch {
    return null;
  }
};

/**
 * Where the branch's own commits now start when `tip` is a rebase of the commits approved (`approved` newest first, from
 * the approval's base to its head), made since `since`; null when it is not. A fixer's own rebase that conflicted may keep
 * the subjects with other patches; `patchesOnly` refuses that, for a caller that needs the same code.
 */
export function rebasedOnto(
  repo: string,
  tip: string,
  approved: LocalCommit[],
  told: string | undefined,
  since: number,
  patchesOnly = false,
): string | null {
  // the story's base ref and main/master first; then wherever the branch's own commits sit, so a branch stacked on
  // another unlanded branch (its merge-base with main is that branch's commits further down) carries too
  const bases: string[] = [];
  for (const ref of new Set(baseRefs(repo, told))) {
    try {
      bases.push(mergeBase(repo, ref, tip));
    } catch {
      // the ref is not here
    }
  }
  if (approved.length) {
    try {
      bases.push(revParse(repo, `${tip}~${approved.length}`));
    } catch {
      // fewer commits than were approved
    }
  }
  for (const base of new Set(bases)) {
    const made = commitLog(repo, [`${base}..${tip}`]);
    if (
      !made.length ||
      made.length !== approved.length ||
      made.some((one) => !(Date.parse(one.at) >= since))
    ) {
      continue;
    }
    const samePatches = made.every((one, place) => {
      const was = patchIdOr(repo, approved[place].sha);
      return was !== null && was === patchIdOr(repo, one.sha);
    });
    if (
      samePatches ||
      (!patchesOnly && made.every((one, place) => one.subject === approved[place].subject))
    ) {
      return base;
    }
  }
  return null;
}

/**
 * What Approve on the page may record for a story pinned to a branch (`--head <branch>`) whose branch has moved since it
 * was told: null when the branch has not moved (approve the story's head as it is); the new tip and its base when the tip
 * is the story's commits rebased (the same patches, so the chapters still describe it); 'stale' when it moved any other way,
 * where an approval at the story's head would lapse at once against the tip and one at the tip would approve code the
 * story never told.
 */
export function approvableTip(meta: LocalMeta): { tip: string; base: string } | 'stale' | null {
  const tip = movedSince(meta)?.head_oid;
  if (!tip) {
    return null;
  }
  const approved = commitLog(meta.repo_path, [`${meta.base_oid}..${meta.head_oid}`]);
  const base = rebasedOnto(meta.repo_path, tip, approved, meta.base, 0, true);
  return base ? { tip, base } : 'stale';
}

/** Carries the approval of the finished fixer run's story to its commit; returns where from and to, and `via: 'rebase'` for a rebase, or null when nothing carried. */
export function carryApproval(
  home: string,
  run: LedgerAgent,
  now = Date.now(),
): { from: string; to: string; via?: 'rebase' } | null {
  const commit = run.result?.commit;
  if (run.role !== 'fixer' || run.state !== 'done' || !run.card || !commit) {
    return null;
  }
  // an implicit card (ADR-27) has no backlog row: the run's own repo and branch are the card's
  const found = new BacklogStore(home).listed().find((one) => one.id === run.card);
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
  let rebasedBase: string | null = null;
  if (isAncestor(entry.repo_path, approval.head_oid, tip)) {
    const made = commitLog(entry.repo_path, [`${approval.head_oid}..${tip}`]);
    if (!made.length || made.some((one) => !(Date.parse(one.at) >= since))) {
      return null;
    }
  } else {
    // or the tip is the approved commits rebased (onto a moved main, a conflict resolved or not)
    const toldDir = stories.dirOf(entry.story.id);
    const told = toldDir ? (readMeta(toldDir) as LocalMeta | null)?.base : undefined;
    const approved = approval.base_oid
      ? commitLog(entry.repo_path, [`${approval.base_oid}..${approval.head_oid}`])
      : [];
    rebasedBase = rebasedOnto(entry.repo_path, tip, approved, told, since);
    if (!rebasedBase) {
      return null;
    }
  }
  const id = entry.story.id;
  const dir = stories.dirOf(id);
  // the story follows its checkout, so its head moves to the commit now rather than on the next page poll
  const meta = dir ? refreshLocal(dir, readMeta(dir) as LocalMeta) : null;
  const { lapsed: _lapsed, ...kept } = approval;
  updateReviewRecord(stories, id, (record) => {
    record.approval = {
      ...kept,
      head_oid: tip,
      base_oid: rebasedBase ?? meta?.base_oid ?? approval.base_oid,
      carried: {
        from: approval.carried?.from ?? approval.head_oid,
        at: new Date(now).toISOString(),
        run: run.run ?? '',
        ...(rebasedBase && { via: 'rebase' as const }),
      },
    };
  });
  return { from: approval.head_oid, to: tip, ...(rebasedBase && { via: 'rebase' as const }) };
}
