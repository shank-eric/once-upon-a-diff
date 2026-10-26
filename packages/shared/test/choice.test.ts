import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshestFirst, obviousChoice, OBVIOUS_MS } from '../src/util/choice.ts';

const ago = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 26, 18, 0) - minutes * 60000).toISOString();

test('sessions are listed freshest first, unknown times last, ties in their order', () => {
  const list = [
    { id: 'old', since: ago(120) },
    { id: 'none', since: null },
    { id: 'new', since: ago(3) },
    { id: 'old-too', since: ago(120) },
  ];
  assert.deepEqual(
    freshestFirst(list).map((one) => one.id),
    ['new', 'old', 'old-too', 'none'],
  );
});

test('the obvious choice is the only session, or one clearly fresher than the next', () => {
  assert.equal(obviousChoice([]), null);
  assert.equal(
    obviousChoice([{ id: 'a', since: null }])?.id,
    'a',
    'the only one, whatever its time',
  );
  assert.equal(
    obviousChoice([
      { id: 'a', since: ago(1) },
      { id: 'b', since: ago(60) },
    ])?.id,
    'a',
  );
  // close together: the page asks
  assert.equal(
    obviousChoice([
      { id: 'a', since: ago(1) },
      { id: 'b', since: ago(3) },
    ]),
    null,
  );
  const margin = OBVIOUS_MS / 60000;
  assert.equal(
    obviousChoice([
      { id: 'a', since: ago(0) },
      { id: 'b', since: ago(margin) },
    ])?.id,
    'a',
    'exactly the margin',
  );
  // several with no times known: no way to tell
  assert.equal(
    obviousChoice([
      { id: 'a', since: null },
      { id: 'b', since: null },
    ]),
    null,
  );
});
