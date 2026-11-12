import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noStoryWhy, NOT_THE_BRIDGE } from '../src/bridge-words.ts';
import { listenError } from '../src/content/listen.ts';

test('a failed proof is worded for a wrong token and for an impostor, everywhere', () => {
  assert.match(NOT_THE_BRIDGE, /doesn't know this token/);
  assert.match(NOT_THE_BRIDGE, /once-upon setup/);
  assert.match(NOT_THE_BRIDGE, /something else holds the port/);
  assert.equal(listenError({ ok: false, status: 0, error: 'not-the-bridge' }), NOT_THE_BRIDGE);
  assert.equal(
    noStoryWhy('not-the-bridge', 'down'),
    `${NOT_THE_BRIDGE[0].toUpperCase()}${NOT_THE_BRIDGE.slice(1)}.`,
  );
});

test('the toast says why there is no story, not just that there is none', () => {
  assert.match(noStoryWhy('bridge-too-old', 'down'), /older than this extension.*restart it/);
  assert.match(noStoryWhy('not-configured'), /options/);
  assert.match(noStoryWhy('unreachable'), /once-upon serve/);
  assert.match(noStoryWhy('HTTP 401', 'token'), /rejected the token/);
  assert.equal(noStoryWhy('none'), 'The bridge has no story for this PR.');
});
