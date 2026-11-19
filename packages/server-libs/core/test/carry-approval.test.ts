import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRebaseCarriable } from '../src/features/review/carry-approval.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
const approval = (over: Record<string, unknown> = {}) =>
  ({
    at: '2026-11-09T12:00:00Z',
    head_oid: 'a'.repeat(40),
    base_oid: 'b'.repeat(40),
    ...over,
  }) as Parameters<typeof isRebaseCarriable>[0];

test('isRebaseCarriable: a fresh approval with a base carries', () => {
  assert.equal(isRebaseCarriable(approval(), now), true);
});

test('isRebaseCarriable: none, a lapsed one, one with no base and a stale one do not', () => {
  assert.equal(isRebaseCarriable(null, now), false);
  assert.equal(isRebaseCarriable(approval({ lapsed: true }), now), false);
  assert.equal(isRebaseCarriable(approval({ base_oid: undefined }), now), false);
  assert.equal(isRebaseCarriable(approval({ at: '2020-01-01T00:00:00Z' }), now), false);
});
