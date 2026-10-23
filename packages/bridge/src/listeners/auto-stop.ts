/*
 * A story listener's natural end. A page showing a story tells the bridge so: the panel's pulse (every 5s while
 * its tab shows) and the local page's version poll (while its panel is closed). The bridge notes the time as the
 * story's seen.json, at most every SEEN_WRITE_MS. A `wait --story` stops itself once no page has shown its story
 * for the idle window (story_listener_idle_minutes in config.json, default 10), counted from when the wait started
 * if no page has shown it since. It never stops while its session has the story's fix request or rebuild in hand.
 * Repo-wide and catch-all waits never stop this way.
 *
 * A tab in the background doesn't pulse, so it counts as no page, the same as a closed one.
 */
import { readFixes } from '../inbox/fixes.ts';
import { Builds } from '../inbox/builds.ts';
import { readSettings } from '../config/settings.ts';
import { plural } from '@once-upon-a-diff/shared/util/text';
import type { StoryStore } from '../stories/store.ts';

export const SEEN_FILE = 'seen.json';
const SEEN_WRITE_MS = 30000;
export const DEFAULT_IDLE_MINUTES = 10;

/** When each story's seen.json was last written by this bridge, so a pulse every 5s writes it twice a minute. */
const lastWritten = new Map<string, number>();

/** A page shows this story now. */
export function noteSeen(stories: StoryStore, id: string, now = Date.now()): void {
  if (now - (lastWritten.get(id) || 0) < SEEN_WRITE_MS) {
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
