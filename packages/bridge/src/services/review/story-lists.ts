/**
 * The built PR stories the review inbox lists: every GitHub story the bridge can find
 * (`story.mjs build` puts them in the checkout's .once-upon/ folder), built in the last STORY_DAYS days. The inbox's
 * Open goes to the PR's changes page, where the panel opens. Mark reviewed is the story's own state file,
 * <home>/state/<story id>/reviewed.json: {at, by}, where `by` is manual, review or all viewed (github-watcher.ts),
 * and an unmark by hand leaves {at: null, by: manual}, so the file's presence means the reviewer has decided.
 *
 * Local stories (`once-upon local`: a branch's story before any PR) are listed beside them (localStories), built in the
 * same days and kept the same way (reviewed.json, position.json, reads). A story an earlier version made for a turn of the
 * retired turn capture (its meta names a `turn`) is left out.
 */
import path from 'node:path';
import { REPO_RE, sameRepo, storyRepo } from '../config/repos.ts';
import { readMeta } from '../stories/meta.ts';
import { readReads } from '../stories/reads.ts';
import { unwrittenCount } from '../stories/skeleton.ts';
import { stateKeyOf } from './drafts.ts';
import { approvalOf, readApproval, type Approval } from './approve.ts';
import type { StoryStore } from '../stories/store.ts';
import type { InboxLocalStory, InboxStory, ReviewedBy } from '@once-upon-a-diff/protocol/types';

/** How long after it was built a PR story stays in the inbox. */
export const STORY_DAYS = 30;
/** A local story nobody has opened, read, marked or rebuilt for this many days counts as done (reviewed by `idle`). */
export const LOCAL_IDLE_DAYS = 3;
/** What marks a local story done without you: its work is on GitHub or in the default branch, or it went quiet. */
export const AUTO_DONE: readonly ReviewedBy[] = ['pr', 'delivered', 'idle'];
/** Branches that are not a unit of work of their own. */
export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk']);
const REVIEWED = 'reviewed.json';
const MERGED = 'merged.json';

/** The latest of some ISO times, or null when there are none. */
const latestOf = (times: (string | null | undefined)[]): string | null =>
  times
    .filter((time): time is string => !!time && !Number.isNaN(Date.parse(time)))
    .sort((first, second) => Date.parse(first) - Date.parse(second))
    .pop() ?? null;

/** The PR stories (newest first), or only a repo's (owner/name). */
export function prStories(
  stories: StoryStore,
  { repo = null, now = Date.now() }: { repo?: string | null; now?: number } = {},
): InboxStory[] {
  const cutoff = now - STORY_DAYS * 24 * 3600 * 1000;
  const found: InboxStory[] = [];
  for (const story of stories.list()) {
    const number = Number(story.number);
    if (
      story.kind !== 'github' ||
      !story.repo ||
      !REPO_RE.test(story.repo) ||
      !Number.isInteger(number) ||
      number < 1 ||
      (repo && !sameRepo(story.repo, repo))
    ) {
      continue;
    }
    const built = Number(story.version);
    if (!built || built < cutoff) {
      continue;
    }
    // a merged PR (or one closed with its branch deleted) is done: not listed, not counted
    if (stories.readState(story.id, MERGED, null) !== null) {
      continue;
    }
    const unwritten = unwrittenCount(story.dir);
    const state = stories.readState<{ at?: string | null; by?: ReviewedBy } | null>(
      story.id,
      REVIEWED,
      null,
    );
    const reads = readReads(stories.home, stateKeyOf(story.id, readMeta(story.dir)));
    const position = stories.readState<{ at?: string } | null>(story.id, 'position.json', null);
    const seen = latestOf([
      state?.at,
      position?.at,
      ...Object.values(reads).map((read) => read.at),
    ]);
    found.push({
      id: story.id,
      repo: story.repo,
      number,
      title: story.title || `${story.repo}#${number}`,
      branch: story.head_ref,
      url: `https://github.com/${story.repo}/pull/${number}/files`,
      built_at: new Date(built).toISOString(),
      seen_at: seen,
      reviewed_at: state?.at || null,
      reviewed_by: state?.at ? state.by || 'manual' : null,
      ...(unwritten && { unwritten }),
    });
  }
  return found.sort(
    (first, second) =>
      second.built_at.localeCompare(first.built_at) || first.id.localeCompare(second.id),
  );
}

/** A local story with what the checks that need git or GitHub (`AutoReview.kickLocal`) look at, which the inbox does not send. */
export interface LocalEntry {
  story: InboxLocalStory;
  repo_path: string | null;
  base_oid: string | null;
  head_oid: string | null;
  /** meta.json's `head`: the ref the story follows (HEAD or a branch), for finding where it is now */
  head_ref: string | null;
  /** the raw approved.json, which the background check clears when the head has moved on */
  approval: Approval | null;
  /** a reviewed.json exists (marked or unmarked by hand, or by a check): the checks leave the story alone */
  marked: boolean;
}

/** Whether a local story's done mark is one of the automatic ones, so a rebuild since you opened it does not bring it back. */
export const isAutoDone = (story: Pick<InboxLocalStory, 'reviewed_at' | 'reviewed_by'>): boolean =>
  !!story.reviewed_at && !!story.reviewed_by && AUTO_DONE.includes(story.reviewed_by);

/**
 * The local stories (newest first), or only a repo's (owner/name), with what the checks look at. A story left by the
 * retired turn capture is not one. A story with no reviewed.json that nothing touched for LOCAL_IDLE_DAYS comes back
 * reviewed by `idle` (worked out here, never written: a rebuild or an open moves it back).
 */
export function localEntries(
  stories: StoryStore,
  { repo = null, now = Date.now() }: { repo?: string | null; now?: number } = {},
): LocalEntry[] {
  const cutoff = now - STORY_DAYS * 24 * 3600 * 1000;
  const found: LocalEntry[] = [];
  for (const story of stories.list()) {
    if (story.kind !== 'local' || story.turn) {
      continue;
    }
    const meta = readMeta(story.dir);
    // when it was told, from meta.json: the folder's newest file time moves whenever a page remakes the diff after
    // HEAD or the base moves, which is not a rebuild. Stories made before built_at was kept fall back to it.
    const toldAt = Date.parse(meta.built_at || '');
    const built = Number.isNaN(toldAt) ? Number(story.version) : toldAt;
    if (!built || built < cutoff) {
      continue;
    }
    const owner = storyRepo(meta);
    const repoName =
      typeof meta.repo_name === 'string' && meta.repo_name
        ? meta.repo_name
        : path.basename(story.repo_path || story.dir);
    // a checkout with no GitHub origin is counted, and picked in the repo menu, under its folder name
    if (repo && !sameRepo(owner || repoName, repo)) {
      continue;
    }
    const state = stories.readState<{ at?: string | null; by?: ReviewedBy } | null>(
      story.id,
      REVIEWED,
      null,
    );
    const reads = readReads(stories.home, stateKeyOf(story.id, meta));
    const position = stories.readState<{ at?: string } | null>(story.id, 'position.json', null);
    const builtAt = new Date(built).toISOString();
    const unwritten = unwrittenCount(story.dir);
    const seen = latestOf([
      state?.at,
      position?.at,
      ...Object.values(reads).map((read) => read.at),
    ]);
    const approved = approvalOf(
      stories,
      story.id,
      typeof meta.head_oid === 'string' ? meta.head_oid : null,
      now,
    );
    let reviewedAt = state?.at || null;
    let reviewedBy: ReviewedBy | null = state?.at ? state.by || 'manual' : null;
    // the mark Approve wrote goes with the approval (a new commit, or a week), so the story is back in Ready at once
    // instead of when the background check next clears the files
    if (reviewedBy === 'approved' && !approved) {
      reviewedAt = null;
      reviewedBy = null;
    }
    const quietSince = Date.parse(latestOf([seen, builtAt]) as string);
    const idleAt = quietSince + LOCAL_IDLE_DAYS * 24 * 3600 * 1000;
    if (state === null && idleAt <= now) {
      reviewedAt = new Date(idleAt).toISOString();
      reviewedBy = 'idle';
    }
    found.push({
      story: {
        id: story.id,
        repo: owner,
        repo_name: repoName,
        title: story.title || story.id,
        branch: story.branch,
        built_at: builtAt,
        seen_at: seen,
        reviewed_at: reviewedAt,
        reviewed_by: reviewedBy,
        approved_at: approved?.at ?? null,
        approved_head: approved?.head_oid ?? null,
        ...(unwritten && { unwritten }),
      },
      repo_path: story.repo_path,
      base_oid: typeof meta.base_oid === 'string' ? meta.base_oid : null,
      head_oid: typeof meta.head_oid === 'string' ? meta.head_oid : null,
      head_ref: typeof meta.head === 'string' ? meta.head : null,
      approval: readApproval(stories, story.id),
      marked: state !== null,
    });
  }
  return found.sort(
    (first, second) =>
      second.story.built_at.localeCompare(first.story.built_at) ||
      first.story.id.localeCompare(second.story.id),
  );
}

/** The local stories (newest first), or only a repo's (owner/name). */
export function localStories(
  stories: StoryStore,
  options: { repo?: string | null; now?: number } = {},
): InboxLocalStory[] {
  return localEntries(stories, options).map((entry) => entry.story);
}

/** One local story by id, or null when the id isn't a listed one's. */
export function localStory(stories: StoryStore, id: string): InboxLocalStory | null {
  return localStories(stories).find((story) => story.id === id) || null;
}

/** A PR the board shows as merged (a story whose PR merged, within `days` of it). */
export interface MergedStory {
  id: string;
  repo: string;
  number: number;
  title: string;
  branch: string | null;
  url: string;
  merged_at: string;
}

/** The stories whose PR merged in the last `hours` hours: merged.json's `merged_at`, else when the bridge noticed. */
export function mergedStories(
  stories: StoryStore,
  { hours = 1, now = Date.now() }: { hours?: number; now?: number } = {},
): MergedStory[] {
  const found: MergedStory[] = [];
  for (const story of stories.list()) {
    const done = stories.readState<{ at?: string; why?: string; merged_at?: string | null } | null>(
      story.id,
      MERGED,
      null,
    );
    const number = Number(story.number);
    if (
      !done ||
      done.why !== 'merged' ||
      story.kind !== 'github' ||
      !story.repo ||
      !REPO_RE.test(story.repo) ||
      !number
    ) {
      continue;
    }
    const mergedMs = Date.parse(done.merged_at || done.at || '');
    if (Number.isNaN(mergedMs) || now - mergedMs > hours * 3600 * 1000) {
      continue;
    }
    found.push({
      id: story.id,
      repo: story.repo,
      number,
      title: story.title || `${story.repo}#${number}`,
      branch: story.head_ref,
      url: `https://github.com/${story.repo}/pull/${number}`,
      merged_at: new Date(mergedMs).toISOString(),
    });
  }
  return found;
}

/** One PR story by id, or null when the id isn't a listed one's. */
export function prStory(stories: StoryStore, id: string): InboxStory | null {
  return prStories(stories).find((story) => story.id === id) || null;
}

/** Whether the story has a reviewed.json at all (marked or unmarked by hand, or by the auto-check). */
export function storyHasState(stories: StoryStore, id: string): boolean {
  return stories.readState(id, REVIEWED, null) !== null;
}

/** Marks a PR story reviewed (the default) or not. An unmark is kept, so the auto-check leaves the story alone. */
export function markStoryReviewed(
  stories: StoryStore,
  id: string,
  reviewed = true,
  reason: ReviewedBy = 'manual',
): void {
  stories.writeState(
    id,
    REVIEWED,
    reviewed ? { at: new Date().toISOString(), by: reason } : { at: null, by: 'manual' },
  );
}

/** Remembers the PR has merged (or was closed and its branch deleted), which drops its story from the inbox. */
export function markStoryDone(
  stories: StoryStore,
  id: string,
  why: 'merged' | 'closed, branch deleted',
  mergedAt: string | null = null,
): void {
  stories.writeState(id, MERGED, { at: new Date().toISOString(), why, merged_at: mergedAt });
}
