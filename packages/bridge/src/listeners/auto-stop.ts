/*
 * A story listener's natural end. A page showing a story tells the bridge so: the panel's pulse (every 5s while
 * its tab shows) and the local page's version poll (while its panel is closed). The bridge notes the time as the
 * story's seen.json, at most every SEEN_WRITE_MS. A `wait --story` stops itself once no page has shown its story
 * for the idle window (story_listener_idle_minutes in config.json, default 10), counted from when the wait started
 * if no page has shown it since. It never stops while its session has the story's fix request or rebuild in hand.
 * A `wait --repo` stops the same way, once no page has shown any of the repo's stories for the idle window
 * (listen_idle_minutes, default 10), and also when the board's Stop listening asks (a stop request: stopRequest). Both
 * are logged to <home>/listeners.log. Catch-all waits never stop this way.
 *
 * A tab in the background doesn't pulse, but its page is still open: while the tab is hidden the panel and the local
 * page send a slow "still open" signal instead (POST /api/stories/<id>/seen, about once a minute, STILL_OPEN_MS in
 * shared/src/overlay.ts and bridge/public/local.ts). It does nothing but note the story as seen, so a reader who keeps the
 * story's tab in the background doesn't lose the listener. Only a closed tab, or a browser that stops its timers, lets
 * the idle window run out.
 */
import { readFixes } from '../inbox/fixes.ts';
import { Builds } from '../inbox/builds.ts';
import { readSettings } from '../config/settings.ts';
import { writeFileAtomic } from '../util/json-file.ts';
import { plural } from '@once-upon-a-diff/shared/util/text';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';
import type { StoryStore } from '../stories/store.ts';

export const SEEN_FILE = 'seen.json';
const SEEN_WRITE_MS = 30000;
export const DEFAULT_IDLE_MINUTES = 10;

/** When each story's seen.json was last written by this bridge, so a pulse every 5s writes it twice a minute. */
const lastWritten = new Map<string, number>();

/** A page shows this story now. `minGap` is how soon after the last write another is made (a hidden tab's rare signal asks for 0). */
export function noteSeen(
  stories: StoryStore,
  id: string,
  now = Date.now(),
  minGap = SEEN_WRITE_MS,
): void {
  if (now - (lastWritten.get(id) || 0) < minGap) {
    return;
  }
  lastWritten.set(id, now);
  try {
    stories.writeState(id, SEEN_FILE, { at: new Date(now).toISOString() });
  } catch {
    /* not worth failing a pulse over */
  }
}

/** When a page last showed the story, in ms, or null when none has. */
export function lastSeen(stories: StoryStore, id: string): number | null {
  const seen = stories.readState<{ at?: string } | null>(id, SEEN_FILE, null);
  const seenAt = seen && seen.at ? Date.parse(seen.at) : NaN;
  return Number.isFinite(seenAt) ? seenAt : null;
}

/** The idle window: story_listener_idle_minutes in config.json, else DEFAULT_IDLE_MINUTES. */
export const idleMsOf = (home: string): number =>
  (readSettings(home).storyListenerIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60000;

/** What this listener still has in hand for the story (a fix request or a rebuild it claimed), or null. */
export function inHand(home: string, consumer: string, story: string): string | null {
  const fixes = Object.values(readFixes(home)).filter(
    (request) =>
      request.story === story && request.claimed_by === consumer && request.status === 'pending',
  );
  if (fixes.length) {
    return plural(fixes.length, 'fix request');
  }
  const rebuilding = new Builds(home)
    .pending()
    .some((build) => build.story === story && build.claimed_by === consumer);
  return rebuilding ? 'a rebuild' : null;
}

/** The window in words: minutes, or seconds for one under a minute (tests use short ones). */
const windowText = (windowMs: number) =>
  windowMs >= 60000
    ? plural(Math.round(windowMs / 60000), 'minute')
    : plural(Math.round(windowMs / 1000), 'second');

/**
 * Why the story's listener should stop now, or null. startedAt is when the wait began, so a story no page has
 * shown since then gets the whole window too.
 */
export function stopReason({
  home,
  stories,
  story,
  consumer,
  startedAt,
  idleMs,
  now = Date.now(),
}: {
  home: string;
  stories: StoryStore;
  story: string;
  consumer: string;
  startedAt: number;
  idleMs: number;
  now?: number;
}): string | null {
  const since = Math.max(lastSeen(stories, story) || 0, startedAt);
  if (now - since < idleMs || inHand(home, consumer, story)) {
    return null;
  }
  return `no page has shown the story for ${windowText(idleMs)}`;
}

/** The idle window for a repo's wait: listen_idle_minutes in config.json, else DEFAULT_IDLE_MINUTES. */
export const repoIdleMsOf = (home: string): number =>
  (readSettings(home).repoListenerIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60000;

/** What this listener still has in hand in the repo (a fix request or a build it claimed), or null. */
function repoInHand(
  home: string,
  consumer: string,
  stories: StoryStore,
  repo: string,
): string | null {
  const storiesOfRepo = new Set(
    stories
      .list()
      .filter((story) => story.repo && sameRepo(story.repo, repo))
      .map((story) => story.id),
  );
  const fixes = Object.values(readFixes(home)).filter(
    (request) =>
      request.claimed_by === consumer &&
      request.status === 'pending' &&
      (storiesOfRepo.has(request.story) || (request.repo && sameRepo(request.repo, repo))),
  );
  if (fixes.length) {
    return plural(fixes.length, 'fix request');
  }
  const building = new Builds(home)
    .pending()
    .some((build) => build.claimed_by === consumer && build.repo && sameRepo(build.repo, repo));
  return building ? 'a build' : null;
}

/**
 * Why a repo's listener should stop now, or null: no page has shown any of the repo's stories for the idle window (counted
 * from when the wait started, if none has since), unless it has a fix request or a build of the repo in hand.
 */
export function repoStopReason({
  home,
  stories,
  repo,
  consumer,
  startedAt,
  idleMs,
  now = Date.now(),
}: {
  home: string;
  stories: StoryStore;
  repo: string;
  consumer: string;
  startedAt: number;
  idleMs: number;
  now?: number;
}): string | null {
  const seen = stories
    .list()
    .filter((story) => story.repo && sameRepo(story.repo, repo))
    .map((story) => lastSeen(stories, story.id) || 0);
  const since = Math.max(startedAt, ...seen);
  if (now - since < idleMs || repoInHand(home, consumer, stories, repo)) {
    return null;
  }
  return `no page has shown one of its stories for ${windowText(idleMs)}`;
}

const STOPS = 'listener-stops.json';

/** The board's Stop listening: every `wait --repo` for the repo that started before now ends on its next look (within ≈2 s). */
export function requestStop(home: string, repo: string, now = Date.now()): void {
  mkdirSync(home, { recursive: true });
  const file = path.join(home, STOPS);
  let stops: Record<string, number> = {};
  try {
    stops = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    stops = {};
  }
  writeFileAtomic(
    file,
    JSON.stringify({ ...stops, [repo.toLowerCase()]: now }, null, 2) + '\n',
    0o600,
  );
}

/** Whether a stop was asked for the repo after this wait started. */
export function stopRequested(home: string, repo: string, startedAt: number): string | null {
  try {
    const stops: Record<string, number> = JSON.parse(readFileSync(path.join(home, STOPS), 'utf8'));
    return (stops[repo.toLowerCase()] ?? 0) >= startedAt ? 'stopped from the board' : null;
  } catch {
    return null;
  }
}

/** One line in <home>/listeners.log when a listener stops by itself or is stopped. */
export function logStop(home: string, line: string): void {
  try {
    appendFileSync(path.join(home, 'listeners.log'), `${new Date().toISOString()} ${line}\n`, {
      mode: 0o600,
    });
  } catch {
    /* the stop still happens */
  }
}
