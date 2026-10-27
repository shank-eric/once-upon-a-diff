/**
 * The built PR stories the review inbox lists: every GitHub story the bridge can find
 * (`story.mjs build` puts them in the checkout's .once-upon/ folder), built in the last STORY_DAYS days. The inbox's
 * Open goes to the PR's changes page, where the panel opens. Mark reviewed is the story's own state file,
 * <home>/state/<story id>/reviewed.json: {at, by}, where `by` is manual, review or all viewed (auto-review.ts),
 * and an unmark by hand leaves {at: null, by: manual}, so the file's presence means the reviewer has decided.
 */
import { REPO_RE, sameRepo } from '../config/repos.ts';
import { readMeta } from '../stories/meta.ts';
import { readReads } from '../stories/reads.ts';
import { stateKeyOf } from '../github/drafts.ts';
import type { StoryStore } from '../stories/store.ts';
import type { InboxStory, ReviewedBy } from '@once-upon-a-diff/shared/types';

/** How long after it was built a PR story stays in the inbox. */
export const STORY_DAYS = 30;
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
      reviewed_by: state?.at ? state.by || null : null,
    });
  }
  return found.sort(
    (first, second) =>
      second.built_at.localeCompare(first.built_at) || first.id.localeCompare(second.id),
  );
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
