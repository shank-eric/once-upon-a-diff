/**
 * The units of work: every built PR story, the PRs merged in the last day, the PRs GitHub waits on you for, the PRs a
 * session has claimed a build for, and the local stories (a branch's story before any PR). A work becomes a card in
 * cards.ts; a session on its branch joins it in sessions.ts.
 */
import { sameRepo } from '../../config/repos.ts';
import { shipMode } from '../../stories/push-default.ts';
import {
  DEFAULT_BRANCHES,
  localEntries,
  mergedStories,
  prStories,
} from '../../review/story-lists.ts';
import type { InboxLocalStory, InboxStory, ShipMode } from '@once-upon-a-diff/protocol/types';
import type { PrWatcher } from './pr-watcher.ts';
import type { BuildContext, Work } from './types.ts';

/** A merged PR stays on the board this long. */
export const MERGED_HOURS = 24;

export const prKey = (repo: string, number: number) => `pr:${repo.toLowerCase()}#${number}`;

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
  /** how each approved local story ships, worked out once per snapshot */
  shipById: Map<string, ShipMode>;
  /** the newest local story's checkout for each repo and branch, for a PR card's commits-ahead count */
  localCheckouts: Map<string, { story: string; checkout: string }>;
}

/**
 * A branch's card with an unresolved local story (approved, or not yet reviewed) and no PR yet takes the PR GitHub says
 * the branch has, whether or not a session is on the branch (sessions.ts does the same for a session's). Without this a
 * squash-merged branch has no PR on its card and an approved story would sit in Ready to ship. An open PR is taken as it
 * is. A merged one only when its last commit is the story's head or its approved head, so a branch that went on after an
 * older PR merged keeps its card. A PR that already has a work of its own is not doubled. A resolved story is not asked about.
 */
function linkBranchWorks(
  works: Map<string, Work>,
  review: PrWatcher,
  checkouts: CollectedWorks['localCheckouts'],
  headsOf: Map<string, string[]>,
  nowMs: number,
): void {
  for (const work of [...works.values()]) {
    const local = work.local;
    if (!local || work.number || work.story || work.mergedAt || !work.repo || !work.branch) {
      continue;
    }
    if (!local.approved_at && local.reviewed_at) {
      continue;
    }
    const checkout = checkouts.get(`${work.repo.toLowerCase()}@${work.branch}`);
    if (!checkout) {
      continue;
    }
    const heads = headsOf.get(local.id) ?? [];
    review.kickBranch(work.repo, work.branch, checkout.checkout, nowMs, heads);
    const found = review.branchPr(work.repo, work.branch);
    if (!found || works.has(prKey(work.repo, found.number))) {
      continue;
    }
    if (found.state === 'merged') {
      if (!found.head_oid || !heads.includes(found.head_oid)) {
        continue;
      }
      work.mergedAt = found.merged_at;
    }
    work.number = found.number;
  }
}

/** Reads the stories and the PR lists into works. Asks the GitHub watcher about what it reads (kick, kickRequested, kickLocal), in this order. */
export function collectWorks(ctx: BuildContext): CollectedWorks {
  const { home, nowMs, review, builds } = ctx;
  // the units of work: every built PR story, and the PRs merged in the last day
  const stories = prStories(ctx.stories, { now: nowMs });
  review.kick(stories);
  const works = new Map<string, Work>();
  const start = (work: Omit<Work, 'sessions' | 'local'>) => startWork(works, work);
  for (const story of stories) {
    start({
      key: prKey(story.repo, story.number),
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
      key: prKey(merged.repo, merged.number),
      repo: merged.repo,
      number: merged.number,
      branch: merged.branch,
      story: null,
      mergedAt: merged.merged_at,
      title: merged.title,
      built: true,
    });
  }
  // PRs GitHub is waiting on your review for, and your own open ones, are units of work too, with or without a story
  review.kickRequested();
  for (const request of review.requested()) {
    const key = prKey(request.repo, request.number);
    if (!works.has(key)) {
      start({
        key,
        repo: request.repo,
        number: request.number,
        branch: null,
        story: null,
        mergedAt: null,
        title: null,
        built: false,
      });
    }
  }
  // a PR a session has claimed a build, rebuild or fix for is a unit of work even with no story yet
  for (const build of builds.pending()) {
    const key = build.repo && build.number ? prKey(build.repo, build.number) : null;
    if (
      key &&
      build.repo &&
      build.number &&
      !works.has(key) &&
      builds.stateOf(build) === 'building'
    ) {
      start({
        key,
        repo: build.repo,
        number: build.number,
        branch: null,
        story: null,
        mergedAt: null,
        title: null,
        built: false,
      });
    }
  }
  // local stories (a branch's story before any PR): the newest per repo and branch goes on that branch's work, or on a
  // branch-only work of its own; a PR story already on the branch is the card's story, so a local one is not
  const localEntryList = localEntries(ctx.stories, { now: nowMs });
  review.kickLocal(localEntryList);
  // how each approved story ships (Push or Create pull request), for its Ready to ship card
  const shipById = new Map<string, ShipMode>(
    localEntryList
      .filter((entry) => entry.story.approved_at && entry.repo_path)
      .map((entry) => [
        entry.story.id,
        shipMode(
          {
            kind: 'local',
            repo: entry.story.repo,
            repo_path: entry.repo_path as string,
            branch: entry.story.branch,
            head_oid: entry.head_oid,
          },
          home,
        ),
      ]),
  );
  const localCheckouts = new Map<string, { story: string; checkout: string }>();
  for (const entry of localEntryList) {
    const { repo, branch } = entry.story;
    if (repo && branch && entry.repo_path) {
      const key = `${repo.toLowerCase()}@${branch}`;
      if (!localCheckouts.has(key)) {
        localCheckouts.set(key, { story: entry.story.id, checkout: entry.repo_path });
      }
    }
  }
  const localStoryList = localEntryList.map((entry) => entry.story);
  const newestLocal = new Map<string, InboxLocalStory>();
  for (const local of localStoryList) {
    if (local.repo && local.branch && !DEFAULT_BRANCHES.has(local.branch)) {
      const key = `${local.repo.toLowerCase()}@${local.branch}`;
      newestLocal.set(key, newestLocal.get(key) ?? local);
    } else if (local.repo) {
      // a story of commits on a default branch, or of a commit range with no branch (one commit each, say): no
      // branch to share, so a card of its own, shown while it waits for review (workCard drops it after)
      start({
        key: `story:${local.id}`,
        repo: local.repo,
        number: null,
        branch: null,
        story: null,
        mergedAt: null,
        title: local.title,
        built: true,
      });
      (works.get(`story:${local.id}`) as Work).local = local;
    }
  }
  for (const local of newestLocal.values()) {
    const repo = local.repo as string;
    const there = [...works.values()].find(
      (work) =>
        work.repo && sameRepo(work.repo, repo) && branchOfWork(review, work) === local.branch,
    );
    if (!there) {
      start({
        key: `branch:${repo.toLowerCase()}@${local.branch}`,
        repo,
        number: null,
        branch: local.branch,
        story: null,
        mergedAt: null,
        title: local.title,
        built: true,
      });
      (works.get(`branch:${repo.toLowerCase()}@${local.branch}`) as Work).local = local;
    } else if (!there.story && !there.mergedAt) {
      there.local = local;
    }
  }
  const headsOf = new Map(
    localEntryList.map((entry) => [
      entry.story.id,
      [entry.head_oid, entry.approval?.head_oid].filter((oid): oid is string => !!oid),
    ]),
  );
  linkBranchWorks(works, review, localCheckouts, headsOf, nowMs);
  return { works, stories, localStoryList, shipById, localCheckouts };
}
