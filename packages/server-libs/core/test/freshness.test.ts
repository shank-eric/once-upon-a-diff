import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFinishedUpdateFrom } from '../src/features/review/freshness.ts';

type Built = Parameters<typeof isFinishedUpdateFrom>[0];
const OLD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const build = (over: Record<string, unknown> = {}) =>
  ({ status: 'done', mode: 'update', base_sha: OLD, ...over }) as Built;

test('isFinishedUpdateFrom: a done update from an older commit than the head is one', () => {
  assert.equal(isFinishedUpdateFrom(build(), HEAD), true);
});

test('isFinishedUpdateFrom: no build, an unfinished or other-mode build, a bad or same base are not', () => {
  assert.equal(isFinishedUpdateFrom(null, HEAD), false);
  assert.equal(isFinishedUpdateFrom(build({ status: 'pending' }), HEAD), false);
  assert.equal(isFinishedUpdateFrom(build({ mode: 'rebuild' }), HEAD), false);
  assert.equal(isFinishedUpdateFrom(build({ base_sha: undefined }), HEAD), false);
  assert.equal(isFinishedUpdateFrom(build({ base_sha: 'nope' }), HEAD), false);
  assert.equal(isFinishedUpdateFrom(build({ base_sha: HEAD.slice(0, 10) }), HEAD), false);
});
