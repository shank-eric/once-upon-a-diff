import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import {
  isStoredBranchPr,
  isStoredPrInfo,
  readGithubAnswers,
} from '../src/stores/github-answers.ts';

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

test('readGithubAnswers keeps fresh well-formed entries and skips stale or malformed ones, a future time reads as now', () => {
  const home = tmp('github-answers-read');
  const now = Date.parse('2026-06-10T00:00:00Z');
  const week = 7 * 24 * 3600 * 1000;
  const info = { number: 4, state: 'open' };
  writeJson(`${home}/github-answers.json`, {
    version: 1,
    branches: {
      good: { at: now - 1000, pr },
      none: { at: now, pr: null },
      stale: { at: now - week, pr },
      future: { at: now + 5000, pr },
      badPr: { at: now, pr: { number: 'x' } },
      badEntry: 'text',
    },
    prs: {
      good: { at: now, info },
      stale: { at: now - week, info },
      badInfo: { at: now, info: { number: 4, state: 'weird' } },
      noAt: { info },
    },
    requested: { at: now, list: [{ repo: 'a/b', number: 1 }] },
  });
  const read = readGithubAnswers(home, now);
  assert.deepEqual(Object.keys(read.branches).sort(), ['future', 'good', 'none']);
  assert.equal(read.branches.future!.at, now);
  assert.equal(read.branches.none!.pr, null);
  assert.deepEqual(Object.keys(read.prs), ['good']);
  assert.deepEqual(read.requested, { at: now, list: [{ repo: 'a/b', number: 1 }] });
});

test('readGithubAnswers refuses a requested list with a malformed item, a stale one, and a file of another version', () => {
  const home = tmp('github-answers-read');
  const now = Date.parse('2026-06-10T00:00:00Z');
  const requested = (askedAt: number, list: unknown) => {
    writeJson(`${home}/github-answers.json`, { version: 1, requested: { at: askedAt, list } });
    return readGithubAnswers(home, now).requested;
  };
  assert.equal(requested(now, [{ repo: 'a/b', number: '1' }]), null);
  assert.equal(requested(now, 'list'), null);
  assert.equal(requested(now - 8 * 24 * 3600 * 1000, []), null);
  writeJson(`${home}/github-answers.json`, { version: 2, requested: { at: now, list: [] } });
  assert.deepEqual(readGithubAnswers(home, now), { branches: {}, prs: {}, requested: null });
});
