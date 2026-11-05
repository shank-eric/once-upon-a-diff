/*
 * What the panel knows about GitHub's commit ranges and a story's requests, with no DOM and no Preact (freshness-part.ts draws
 * the line under the toolbar and the "Since you read it" banner): which chapter a range page is, the link to a range's diff,
 * and what to say while a session has a request for the story.
 *
 * Node tests use these.
 */
import { sameSha } from '@once-upon-a-diff/domain/text';
import { clockTime, minutesSince } from '@once-upon-a-diff/domain/time';
import { rangeOfPath } from '@once-upon-a-diff/domain/pr-key';
import type { StoryRequest } from '@once-upon-a-diff/protocol/types';

export { rangeOfPath };

/** The step (1-based) of the "Since you read it" chapter for the range this page shows, or null. */
export function rangeStepOf(
  chapters: { since?: { from: string; to: string } }[],
  pathname: string,
): number | null {
  const range = rangeOfPath(pathname);
  if (!range) {
    return null;
  }
  const index = chapters.findIndex(
    (chapter) =>
      chapter.since &&
      sameSha(chapter.since.from, range.from) &&
      sameSha(chapter.since.to, range.to),
  );
  return index < 0 ? null : index + 1;
}

/**
 * The link to GitHub's diff of just a chapter's commits. /changes/<from>..<to> loads as is logged in
 * (checked 2026-10-22) and redirects to /files/<from>..<to> logged out.
 */
export const rangeUrl = (
  prUrl: string | null | undefined,
  since: { from: string; to: string } | null | undefined,
): string | null =>
  prUrl && since ? `${String(prUrl).replace(/\/+$/, '')}/changes/${since.from}..${since.to}` : null;

const DOING: Record<StoryRequest['kind'], string> = {
  build: 'Building the story for you…',
  update: 'Updating the story for you…',
  rebuild: 'Rebuilding the story for you…',
  fix: 'Fixing the code for you…',
};

/**
 * What to say while a session has a request for the story, instead of offering Update: building once a listener has
 * taken it (when it started, and who), queued until one does (when it was asked). No DOM, so node tests can use it.
 */
export function requestLine(
  request: StoryRequest | null | undefined,
  now = Date.now(),
): { text: string; detail: string } | null {
  if (!request) {
    return null;
  }
  const asked = clockTime(request.requested_at);
  if (request.state === 'queued') {
    return {
      text: 'Waiting for a Claude session to pick this up…',
      detail: asked ? `asked at ${asked}` : '',
    };
  }
  const minutes = minutesSince(request.claimed_at || request.requested_at, now);
  const started = clockTime(request.claimed_at || request.requested_at);
  const detail = [
    started &&
      `started ${started}${minutes !== null && minutes >= 1 ? ` (${minutes} min ago)` : ''}`,
    request.claimed_by,
  ]
    .filter(Boolean)
    .join(', ');
  return { text: DOING[request.kind], detail };
}
