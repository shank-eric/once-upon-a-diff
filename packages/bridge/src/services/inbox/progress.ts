/**
 * What a session is doing for a story or PR right now: a build, update or rebuild request (builds.ts) or a fix request
 * (fixes.ts) that a listener has taken ("building") or not yet ("queued"). The panel's pulse says it, so Update gives
 * way to an in-progress line, and the agent board puts the PR's card in Working.
 */
import { readFixes } from './fixes.ts';
import { sameRepo } from '../config/repos.ts';
import { storyKey, type Build, type Builds } from './builds.ts';
import { isRebuild } from '../stories/rebuild.ts';
import type { StoryRequest } from '@once-upon-a-diff/protocol/types';

/** The PR number a pull request URL ends in (`…/pull/12`, maybe with `/files` or a query after it), or null. */
const pullNumberOf = (url: string | null | undefined): number | null => {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url || '');
  return match ? Number(match[1]) : null;
};

const kindOf = (build: Build): StoryRequest['kind'] => {
  if (build.mode === 'rebuild' || build.mode === 'rebuild_from') {
    return 'rebuild';
  }
  return build.mode === 'update' ? 'update' : 'build';
};

/** A build request as a StoryRequest, or null once it is done, failed or none. */
function ofBuild(builds: Builds, build: Build | null): StoryRequest | null {
  const state = builds.stateOf(build);
  if (!build || (state !== 'queued' && state !== 'building')) {
    return null;
  }
  return {
    kind: kindOf(build),
    state,
    requested_at: build.requested_at,
    claimed_by: state === 'building' ? build.claimed_by || null : null,
    claimed_at: state === 'building' ? build.claimed_at || null : null,
  };
}

/**
 * The unfinished request for a PR (by repo and number) and/or a story (by id), building ones first. A build request is
 * one per PR; a fix request belongs to a story.
 */
export function requestFor(
  home: string,
  builds: Builds,
  { repo, number, story }: { repo?: string | null; number?: number | null; story?: string | null },
): StoryRequest | null {
  const found: StoryRequest[] = [];
  let build: Build | null = null;
  if (repo && number) {
    build = builds.get(repo, number);
  } else if (story) {
    build = builds.all()[storyKey(story)] || null;
  }
  // a rebuild belongs to the story it was asked for (a PR can have more than one story); builds and updates are the PR's
  if (story && isRebuild(build) && build?.story !== story) {
    build = null;
  }
  const own = ofBuild(builds, build);
  if (own) {
    found.push(own);
  }
  for (const fix of Object.values(readFixes(home))) {
    const forStory = story && fix.story === story;
    const forPr =
      repo &&
      number &&
      fix.repo &&
      sameRepo(fix.repo, repo) &&
      pullNumberOf(fix.url) === Number(number);
    if (fix.status === 'pending' && (forStory || forPr)) {
      found.push({
        kind: 'fix',
        state: fix.claimed_by ? 'building' : 'queued',
        requested_at: fix.requested_at,
        claimed_by: fix.claimed_by || null,
        claimed_at: fix.claimed_at || null,
      });
    }
  }
  return (
    found.sort(
      (first, second) => Number(second.state === 'building') - Number(first.state === 'building'),
    )[0] || null
  );
}
