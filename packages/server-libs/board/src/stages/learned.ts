/**
 * What a build learned about each piece of work (ADR-29, branch B), for the card keeper: the facts the stages already found, as
 * `LearnedCards`. It reads and writes nothing (the Board hands the answer to the keeper); it runs last, so every session is on its work.
 *
 * A work (a PR, a branch with a story, a PR a build was asked for) is learned when it has a branch, a story, a build in flight, a session on it,
 * or, for a PR of yours, when GitHub says it was opened in the last 24 hours: any other open PR (an old one of yours, one that waits on
 * you with no work) is not stored, the board keeps finding it from GitHub's lists. A merged or closed work is never learned: its number
 * goes in `ended`, so new work on the branch name is a new card (and a PR GitHub says is open goes in `open`). A session standing alone is learned only on a feature branch of a repo
 * GitHub's lookup answered for (a session on main, or whose lookup timed out, is not), and not when a run of its own is open (its
 * agent card is the card). An editor, a listener, the voice session and a blank session are never learned.
 */
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import type { Worktree } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import type { LearnedCard, LearnedCards } from '@once-upon-a-diff/core/features/cards/learned';
import type { SessionLearned } from './sessions.ts';
import type { BuildContext, Work } from './types.ts';

/** A PR of yours opened this recently is a card of its own, with no story or session. */
export const NEW_PR_MS = 24 * 3600 * 1000;

/** The checkout of `branch` among a session's repo's worktrees, or null. */
async function worktreeOn(
  ctx: BuildContext,
  cwds: string[],
  branch: string,
): Promise<string | null> {
  for (const cwd of cwds) {
    const trees: Worktree[] = await ctx.lookups.worktreesOf(cwd, ctx.nowMs);
    const found = trees.find((tree) => tree.branch === branch);
    if (found) {
      return found.path;
    }
  }
  return null;
}

export async function learnCards(
  ctx: BuildContext,
  works: Map<string, Work>,
  sessions: SessionLearned[],
): Promise<LearnedCards> {
  const { review, nowMs } = ctx;
  const cards: LearnedCard[] = [];
  const ended: LearnedCards['ended'] = [];
  const open: LearnedCards['open'] = [];
  const building = ctx.builds
    .pending()
    .filter((build) => ctx.builds.stateOf(build) === 'building' && build.repo && build.number);
  const cwdsOf = new Map<string, string[]>();
  for (const one of sessions) {
    if (one.workKey) {
      cwdsOf.set(one.workKey, [...(cwdsOf.get(one.workKey) ?? []), one.cwd]);
    }
  }
  const requested = review.requested();
  for (const work of works.values()) {
    if (!work.repo) {
      continue;
    }
    const info = work.number ? review.info(work.repo, work.number) : null;
    if (work.mergedAt || info?.state === 'merged' || info?.state === 'closed') {
      if (work.number) {
        ended.push({ repo: work.repo, number: work.number });
      }
      continue;
    }
    if (work.number && info?.state === 'open') {
      open.push({ repo: work.repo, number: work.number });
    }
    const branch = work.branch ?? info?.branch ?? null;
    if (!branch || DEFAULT_BRANCHES.has(branch)) {
      continue;
    }
    const story = work.story?.id ?? work.local?.id ?? null;
    const asked = building.some(
      (build) => sameRepo(build.repo, work.repo) && build.number === work.number,
    );
    const created = requested.find(
      (one) => sameRepo(one.repo, work.repo) && one.number === work.number,
    )?.created_at;
    const fresh =
      !!info?.mine &&
      !!created &&
      nowMs - Date.parse(created) <= NEW_PR_MS &&
      nowMs >= Date.parse(created);
    if (!story && !asked && !work.sessions.length && !fresh) {
      continue;
    }
    const pr = info ? work.number : null;
    const source = pr ? 'pr' : 'story';
    cards.push({
      kind: 'work',
      source: pr || story ? source : 'session',
      title: info?.title ?? work.story?.title ?? work.local?.title ?? work.title ?? branch,
      repo: work.repo,
      branch,
      worktree: await worktreeOn(ctx, cwdsOf.get(work.key) ?? [], branch),
      pr,
      asked: pr ? null : (work.number ?? null),
      story,
      ...(!work.story && work.local
        ? { newestLocal: true as const, storyBuiltAt: work.local.built_at }
        : {}),
      session: work.sessions[0]?.card.id ?? null,
    });
  }
  for (const one of sessions) {
    if (
      one.workKey ||
      one.hasRun ||
      !one.repoAnswered ||
      !one.repo ||
      !one.branch ||
      DEFAULT_BRANCHES.has(one.branch)
    ) {
      continue;
    }
    cards.push({
      kind: 'session',
      source: 'session',
      title: one.title,
      repo: one.repo,
      branch: one.branch,
      worktree: await worktreeOn(ctx, [one.cwd], one.branch),
      pr: null,
      story: null,
      session: one.session,
    });
  }
  return { cards, ended, open };
}
