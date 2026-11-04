import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLine } from '@once-upon-a-diff/panel/rebuild/freshness';
import type { StoryRequest } from '@once-upon-a-diff/protocol/types';

const request = (extra: Partial<StoryRequest> = {}): StoryRequest => ({
  kind: 'update',
  state: 'building',
  requested_at: '2026-10-26T18:00:00Z',
  claimed_by: 'session-a',
  claimed_at: '2026-10-26T18:02:00Z',
  ...extra,
});

test('with no request there is nothing to say, so Update stays', () => {
  assert.equal(requestLine(null), null);
  assert.equal(requestLine(undefined), null);
});

test('a request a session has taken is in progress, and says what, since when and by whom', () => {
  const now = Date.parse('2026-10-26T18:12:00Z');
  for (const [kind, text] of [
    ['build', 'Building the story for you…'],
    ['update', 'Updating the story for you…'],
    ['rebuild', 'Rebuilding the story for you…'],
    ['fix', 'Fixing the code for you…'],
  ] as const) {
    const line = requestLine(request({ kind }), now);
    assert.equal(line?.text, text);
    assert.match(line?.detail || '', /^started .*\(10 min ago\), session-a$/);
  }
});

test('a request nobody has taken yet is waiting, with when it was asked', () => {
  const line = requestLine(request({ state: 'queued', claimed_by: null, claimed_at: null }));
  assert.equal(line?.text, 'Waiting for a Claude session to pick this up…');
  assert.match(line?.detail || '', /^asked at /);
});
