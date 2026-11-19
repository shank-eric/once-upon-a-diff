import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStoredBranchPr, isStoredPrInfo } from '../src/stores/github-answers.ts';

const pr = { number: 7, state: 'merged', merged_at: '2026-01-01T00:00:00Z', head_oid: 'abc' };

test('isStoredBranchPr: a well-formed record passes, with or without the optional head and shipped list', () => {
  assert.equal(isStoredBranchPr(pr), true);
  assert.equal(isStoredBranchPr({ number: 7, state: 'open', merged_at: null }), true);
  assert.equal(isStoredBranchPr({ ...pr, shipped: ['a', 'b'] }), true);
});

test('isStoredBranchPr: each wrong field is refused', () => {
  assert.equal(isStoredBranchPr(null), false);
  assert.equal(isStoredBranchPr([pr]), false);
  assert.equal(isStoredBranchPr({ ...pr, number: '7' }), false);
  assert.equal(isStoredBranchPr({ ...pr, state: 'closed' }), false);
  assert.equal(isStoredBranchPr({ ...pr, merged_at: undefined }), false);
  assert.equal(isStoredBranchPr({ ...pr, head_oid: 3 }), false);
  assert.equal(isStoredBranchPr({ ...pr, shipped: 'a' }), false);
  assert.equal(isStoredBranchPr({ ...pr, shipped: ['a', 1] }), false);
});

test('isStoredPrInfo: a number with an open, merged or closed state passes, anything else does not', () => {
  for (const state of ['open', 'merged', 'closed']) {
    assert.equal(isStoredPrInfo({ number: 3, state }), true);
  }
  assert.equal(isStoredPrInfo(undefined), false);
  assert.equal(isStoredPrInfo({ number: '3', state: 'open' }), false);
  assert.equal(isStoredPrInfo({ number: 3, state: 'draft' }), false);
});
