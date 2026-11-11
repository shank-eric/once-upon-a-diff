/*
 * What the panel knows about a story's requests, with no DOM and no Preact (freshness-part.ts draws
 * the line under the toolbar and the "Since you read it" banner): what to say while a session has a request for the story.
 *
 * Node tests use these.
 */
import { clockTime, minutesSince } from '@once-upon-a-diff/terms/time';
import type { StoryRequest } from '@once-upon-a-diff/contracts/types';

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
