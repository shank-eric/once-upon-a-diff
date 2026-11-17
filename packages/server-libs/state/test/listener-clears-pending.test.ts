/**
 * A listener's heartbeat drops the queued Start listening (pending-listen/<key>.json) it covers, so a request left after a
 * listener started another way (the line pasted by hand, a tab that became idle) cannot start a second one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { writePending } from '@once-upon-a-diff/adapters/claude-sessions/pending-listen';
import { beat } from '../src/records/listeners/listeners.ts';

const KEYS = ['repo-acme-widgets', 'repo-acme-gadgets', 'story-local-feat-x'];

function queued() {
  const home = tmp('listener-pending');
  for (const key of KEYS) {
    writePending(home, key, '{}');
  }
  const left = () =>
    KEYS.filter((key) => existsSync(path.join(home, 'pending-listen', `${key}.json`)));
  return { home, left };
}

test('a repo listener drops its repo’s request, whatever the case, and leaves the others', () => {
  const { home, left } = queued();
  beat(home, 'repo-acme-widgets', 'waiting', { repo: 'Acme/Widgets' });
  assert.deepEqual(left(), ['repo-acme-gadgets', 'story-local-feat-x']);
});

test('a story listener drops its story’s request only', () => {
  const { home, left } = queued();
  beat(home, 'story-local-feat-x', 'waiting', { story: 'local-feat-x' });
  assert.deepEqual(left(), ['repo-acme-widgets', 'repo-acme-gadgets']);
});

test('a listener for everything drops every repo request, not a story’s', () => {
  const { home, left } = queued();
  beat(home, 'default', 'handling');
  assert.deepEqual(left(), ['story-local-feat-x']);
});

test('a beat with nothing queued writes no pending-listen folder', () => {
  const home = tmp('listener-pending-none');
  beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
  assert.equal(existsSync(path.join(home, 'pending-listen')), false);
});
