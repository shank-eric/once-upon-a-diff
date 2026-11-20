/**
 * The units of work: every built PR story, the PRs merged in the last day, the PRs GitHub waits on you for, the PRs a
 * session has claimed a build for, and the local stories (a branch's story before any PR). A work becomes a card in
 * cards.ts; a session on its branch joins it in sessions.ts.
 */
import { branchKey, branchWorkKey, prWorkKey, storyWorkKey } from '@once-upon-a-diff/terms/ids';
import { hasRepoAndBranch } from '@once-upon-a-diff/terms/repo-branch';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import type { BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import {
  type LocalEntry,
  localEntries,
  mergedStories,
  prStories,
} from '@once-upon-a-diff/core/features/review/story-lists';
import type { InboxLocalStory, InboxStory } from '@once-upon-a-diff/contracts/types';
import type { PrWatcher } from './pr-watcher.ts';
import type { BuildContext, Work } from './types.ts';

/** A merged PR stays on the board this long. */
export const MERGED_HOURS = 1;

/** Adds a work to the map, with no session and no local story yet. */
export function startWork(works: Map<string, Work>, work: Omit<Work, 'sessions' | 'local'>): void {
  works.set(work.key, { ...work, local: null, sessions: [] });
}

/** The branch a work is on: its own, else the one GitHub says its PR is from. */
export const branchOfWork = (review: PrWatcher, work: Work): string | null | undefined =>
  work.branch ?? (work.repo && work.number ? review.info(work.repo, work.number)?.branch : null);

export interface CollectedWorks {
  works: Map<string, Work>;
  /** the PR stories that were read, for the columns' story facts */
  stories: InboxStory[];
  /** every local story, newest first */
  localStoryList: InboxLocalStory[];
  /** the newest local story's checkout for each repo and branch, for a PR card's commits-ahead count */
  localCheckouts: Map<string, { story: string; checkout: string }>;
  /** each local story's told head (the commit its chapters were told over), for a Ready card whose branch moves past it */
  toldHeads: Map<string, string>;
}

/** A work that is only a branch's local story: no PR, no PR story, not merged, on a repo and branch. */
export type BranchWithLocalStory = Work & { local: InboxLocalStory; repo: string; branch: string };

export function isBranchWithLocalStory(work: Work): work is BranchWithLocalStory {
  return !!work.local && !work.number && !work.story && !work.mergedAt && hasRepoAndBranch(work);
}

/** A local story you have reviewed and not approved: resolved, so GitHub is not asked about its branch. */
export function isResolved(local: InboxLocalStory): boolean {
  return !local.approved_at && !!local.reviewed_at;
}

/**
 * A branch's card with an unresolved local story (approved, or not yet reviewed) and no PR yet takes the PR GitHub says
 * the branch has, whether or not a session is on the branch (sessions.ts does the same for a session's). Without this a
 * squash-merged branch has no PR on its card and an approved story would sit in Ready to ship. An open PR is taken as it
 * is. A merged one only when its last commit is the story's head or its approved head, or one of those is among its
 * commits (GitHub may have added one after the approval), so a branch that went on after an older PR merged keeps its card. A PR that already has a work of its own (one of yours from GitHub's list, before GitHub has
 * said which branch it is from) is not doubled: an open one takes the local story (whatever mark that work carries), and the branch's card goes. A resolved
 * story is not asked about.
 */
function linkBranchWorks(
  works: Map<string, Work>,
  review: PrWatcher,
  checkouts: CollectedWorks['localCheckouts'],
  headsOf: Map<string, string[]>,
  nowMs: number,
): void {
  for (const work of [...works.values()]) {
    if (!isBranchWithLocalStory(work) || isResolved(work.local)) {
      continue;
    }
    const checkout = checkouts.get(branchKey(work.repo, work.branch));
    if (!checkout) {
      continue;
    }
    const heads = headsOf.get(work.local.id) ?? [];
    review.kickBranch(work.repo, work.branch, checkout.checkout, nowMs, heads);
    const found = review.branchPr(work.repo, work.branch);
    if (found) {
      linkBranchWork(works, work, found, heads);
    }
  }
}

/** Gives a branch's work the PR GitHub says the branch has (see linkBranchWorks). */
function linkBranchWork(
  works: Map<string, Work>,
  work: BranchWithLocalStory,
  found: BranchPr,
  heads: string[],
): void {
  const there = works.get(prWorkKey(work.repo, found.number));
  if (there) {
    // The PR already has a work of its own (one of yours, from GitHub's list, before GitHub has said which branch it is
    // from): the branch's card goes instead of staying as a second card with no PR in Ready to ship, and the local story
    // goes on the PR's work unless that has a story of its own.
    if (found.state === 'open') {
      if (!there.story && !there.local) {
        there.local = work.local;
      }
      there.branch = there.branch ?? work.branch;
      works.delete(work.key);
    }
    return;
  }
  if (found.state === 'merged') {
    // the story's own commit is the PR's last, or among its commits when GitHub added one after the approval
    const ours =
      (!!found.head_oid && heads.includes(found.head_oid)) ||
      !!found.shipped?.some((head) => heads.includes(head));
    if (!ours) {
      return;
    }
    work.mergedAt = found.merged_at;
  }
  work.number = found.number;
}

type Start = (work: Omit<Work, 'sessions' | 'local'>) => void;

/** A PR GitHub is waiting on your review for, or a PR a session has claimed a build, rebuild or fix for, is a unit of work too. */
function startRequestedWorks(ctx: BuildContext, works: Map<string, Work>, start: Start): void {
  const { nowMs, review, builds } = ctx;
  const bare = { branch: null, story: null, mergedAt: null, title: null, built: false };
  // PRs GitHub is waiting on your review for, and your own open ones, are units of work too, with or without a story
  review.kickRequested(nowMs);
  for (const request of review.requested()) {
    const key = prWorkKey(request.repo, request.number);
    if (!works.has(key)) {
      start({ key, repo: request.repo, number: request.number, ...bare });
    }
  }
  // a PR a session has claimed a build, rebuild or fix for is a unit of work even with no story yet
  for (const build of builds.pending()) {
    const key = build.repo && build.number ? prWorkKey(build.repo, build.number) : null;
    if (
      key &&
      build.repo &&
      build.number &&
      !works.has(key) &&
      builds.stateOf(build) === 'building'
    ) {
      start({ key, repo: build.repo, number: build.number, ...bare });
    }
  }
}

/** The newest local story's checkout for each repo and branch. */
function checkoutsOf(entries: LocalEntry[]): CollectedWorks['localCheckouts'] {
  const checkouts: CollectedWorks['localCheckouts'] = new Map();
  for (const entry of entries) {
    const { repo, branch } = entry.story;
    if (repo && branch && entry.repo_path) {
      const key = branchKey(repo, branch);
      if (!checkouts.has(key)) {
        checkouts.set(key, { story: entry.story.id, checkout: entry.repo_path });
      }
    }
  }
  return checkouts;
}

/** A work of its own for a local story that has no branch to share, shown while it waits for review (workCard drops it after). */
function startStoryWork(works: Map<string, Work>, start: Start, local: InboxLocalStory): void {
  // a story of commits on a default branch, or of a commit range with no branch (one commit each, say): no
  // branch to share, so a card of its own
  const key = storyWorkKey(local.id);
  start({
    key,
    repo: local.repo,
    number: null,
    branch: null,
    story: null,
    mergedAt: null,
    title: local.title,
    built: true,
  });
  (works.get(key) as Work).local = local;
}

/** The newest local story of a branch goes on that branch's work, or on a branch-only work of its own. */
function placeBranchStory(
  works: Map<string, Work>,
  review: PrWatcher,
  start: Start,
  local: InboxLocalStory,
): void {
  const repo = local.repo as string;
  const there = [...works.values()].find(
    (work) => work.repo && sameRepo(work.repo, repo) && branchOfWork(review, work) === local.branch,
  );
  if (there) {
    if (!there.story && !there.mergedAt) {
      there.local = local;
    }
    return;
  }
  const key = branchWorkKey(repo, local.branch as string);
  start({
    key,
    repo,
    number: null,
    branch: local.branch,
    story: null,
    mergedAt: null,
    title: local.title,
    built: true,
  });
  (works.get(key) as Work).local = local;
}

/**
 * Local stories (a branch's story before any PR): the newest per repo and branch goes on that branch's work, or on a
 * branch-only work of its own; a PR story already on the branch is the card's story, so a local one is not.
 */
function placeLocalStories(
  works: Map<string, Work>,
  review: PrWatcher,
  start: Start,
  stories: InboxLocalStory[],
): void {
  const newestLocal = new Map<string, InboxLocalStory>();
  for (const local of stories) {
    if (local.repo && isFeatureBranch(local.branch)) {
      const key = branchKey(local.repo, local.branch);
      newestLocal.set(key, newestLocal.get(key) ?? local);
    } else if (local.repo) {
      startStoryWork(works, start, local);
    }
  }
  for (const local of newestLocal.values()) {
    placeBranchStory(works, review, start, local);
  }
}

/** Reads the stories and the PR lists into works. Asks the GitHub watcher about what it reads (kick, kickRequested, kickLocal), in this order. */
export function collectWorks(ctx: BuildContext): CollectedWorks {
  const { nowMs, review } = ctx;
  // the units of work: every built PR story, and the PRs merged in the last day
  const stories = prStories(ctx.stories, { now: nowMs });
  review.kick(stories, nowMs);
  const works = new Map<string, Work>();
  const start: Start = (work) => startWork(works, work);
  for (const story of stories) {
    start({
      key: prWorkKey(story.repo, story.number),
      repo: story.repo,
      number: story.number,
      branch: story.branch,
      story,
      mergedAt: null,
      title: story.title,
      built: true,
    });
  }
  for (const merged of mergedStories(ctx.stories, { hours: MERGED_HOURS, now: nowMs })) {
    start({
      key: prWorkKey(merged.repo, merged.number),
      repo: merged.repo,
      number: merged.number,
      branch: merged.branch,
      story: null,
      mergedAt: merged.merged_at,
      title: merged.title,
      built: true,
    });
  }
  startRequestedWorks(ctx, works, start);
  const localEntryList = localEntries(ctx.stories, { now: nowMs });
  review.kickLocal(localEntryList, nowMs);
  const localCheckouts = checkoutsOf(localEntryList);
  const localStoryList = localEntryList.map((entry) => entry.story);
  placeLocalStories(works, review, start, localStoryList);
  const headsOf = new Map(
    localEntryList.map((entry) => [
      entry.story.id,
      [entry.head_oid, entry.approval?.head_oid].filter((oid): oid is string => !!oid),
    ]),
  );
  linkBranchWorks(works, review, localCheckouts, headsOf, nowMs);
  const toldHeads = new Map(
    localEntryList.flatMap((entry) =>
      entry.told_head_oid ? [[entry.story.id, entry.told_head_oid] as const] : [],
    ),
  );
  return { works, stories, localStoryList, localCheckouts, toldHeads };
}
