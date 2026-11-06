import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, elapsedText, since } from '../src/time.ts';

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const before = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

test('elapsed time reads as minutes and seconds, then hours', () => {
  assert.equal(elapsedText(42_000), '0:42');
  assert.equal(elapsedText(12 * 60_000 + 3_000), '12:03');
  assert.equal(elapsedText(3_723_000), '1:02:03');
  assert.equal(elapsedText(-5), '0:00');
});

test('ago says "just now" in the first minute, then how long, and nothing without a time', () => {
  assert.equal(ago(before(0), NOW), 'just now');
  assert.equal(ago(before(5), NOW), '5m ago');
  assert.equal(ago(before(180), NOW), '3h ago');
  assert.equal(ago(null, NOW), '');
});

test('since gives the bare age, or nothing without a time', () => {
  assert.equal(since(before(5), NOW), '5m');
  assert.equal(since(null, NOW), '');
});
