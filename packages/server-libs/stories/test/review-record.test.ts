import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import {
  REVIEW_FILE,
  isDecided,
  markOf,
  readReviewRecord,
  recordFromLegacy,
} from '../src/review-record.ts';
import { approvalOf } from '../src/approval.ts';
import { StoryStore } from '../src/store.ts';

const WHEN = '2026-11-01T10:00:00.000Z';
const approval = { at: WHEN, head_oid: 'a'.repeat(40), base_oid: null };

test('a legacy reviewed.json is the mark, a hand unmark stays an unmark, a plain object reads manual', () => {
  assert.deepEqual(recordFromLegacy({ at: WHEN, by: 'review' }, null), {
    mark: { at: WHEN, by: 'review' },
  });
  assert.deepEqual(recordFromLegacy({ at: WHEN }, null), { mark: { at: WHEN, by: 'manual' } });
  assert.deepEqual(recordFromLegacy({ at: null, by: 'manual' }, null), {
    mark: { at: null, by: 'manual' },
  });
});

test('legacy: the mark Approve wrote is no mark of its own, unless the story had been unmarked before approving', () => {
  const legacy = { ...approval, marked: true };
  assert.deepEqual(recordFromLegacy({ at: WHEN, by: 'approved' }, legacy), { approval });
  assert.deepEqual(recordFromLegacy({ at: WHEN, by: 'approved' }, { ...legacy, unmarked: true }), {
    approval,
    mark: { at: null, by: 'manual' },
  });
  // a hand mark kept under an approval keeps its by
  assert.deepEqual(recordFromLegacy({ at: WHEN, by: 'review' }, { ...approval, marked: false }), {
    approval,
    mark: { at: WHEN, by: 'review' },
  });
  // lapsed and carried ride along; marked and unmarked do not
  const carried = { from: 'b'.repeat(40), at: WHEN, run: 'fix-x', via: 'rebase' as const };
  assert.deepEqual(recordFromLegacy(null, { ...approval, marked: true, lapsed: true, carried }), {
    approval: { ...approval, lapsed: true, carried },
  });
});

test('legacy: a stale approved mark with no approved.json is nothing, and no files is no record', () => {
  assert.equal(recordFromLegacy({ at: WHEN, by: 'approved' }, null), null);
  assert.equal(recordFromLegacy(null, null), null);
});

function store(files: Record<string, unknown>) {
  const home = tmp('review-record');
  for (const [name, value] of Object.entries(files)) {
    writeJson(path.join(home, 'state', 's1', name), value);
  }
  return new StoryStore({ home });
}

test('review.json is read, and a missing or null one reads the legacy pair, without writing anything', () => {
  const now = store({ [REVIEW_FILE]: { mark: { at: WHEN, by: 'all viewed' }, approval } });
  assert.deepEqual(readReviewRecord(now, 's1'), {
    mark: { at: WHEN, by: 'all viewed' },
    approval,
  });
  const legacy = store({
    'reviewed.json': { at: WHEN, by: 'pr' },
    'approved.json': { ...approval, marked: false },
  });
  assert.deepEqual(readReviewRecord(legacy, 's1'), { mark: { at: WHEN, by: 'pr' }, approval });
  const nulled = store({ [REVIEW_FILE]: null, 'reviewed.json': { at: WHEN, by: 'pr' } });
  assert.deepEqual(readReviewRecord(nulled, 's1'), { mark: { at: WHEN, by: 'pr' } });
  assert.equal(legacy.readState('s1', REVIEW_FILE, null), null, 'a read writes nothing');
  assert.equal(readReviewRecord(store({}), 's1'), null);
});

test('a legacy file written after review.json exists (a bridge not yet restarted) overrides its facet only', () => {
  const stories = store({
    [REVIEW_FILE]: { mark: { at: WHEN, by: 'manual' }, approval },
    'reviewed.json': { at: '2026-11-02T00:00:00.000Z', by: 'review' },
  });
  assert.deepEqual(readReviewRecord(stories, 's1'), {
    mark: { at: '2026-11-02T00:00:00.000Z', by: 'review' },
    approval,
  });
  const approved = store({
    [REVIEW_FILE]: { mark: { at: WHEN, by: 'manual' } },
    'approved.json': { ...approval, marked: true },
    'reviewed.json': { at: WHEN, by: 'approved' },
  });
  assert.deepEqual(
    readReviewRecord(approved, 's1'),
    { mark: { at: WHEN, by: 'manual' }, approval },
    'the old bridge approving leaves the hand mark in review.json alone',
  );
  const unmarked = store({
    [REVIEW_FILE]: { mark: { at: WHEN, by: 'manual' } },
    'reviewed.json': { at: null, by: 'manual' },
  });
  assert.deepEqual(readReviewRecord(unmarked, 's1'), { mark: { at: null, by: 'manual' } });
});

test('a damaged review.json reads what it can: no mark.by is manual, a wrong-typed field is absent', () => {
  const stories = store({
    [REVIEW_FILE]: {
      mark: { at: WHEN },
      approval: { at: WHEN, head_oid: 7, base_oid: null },
      extra: 1,
    },
  });
  assert.deepEqual(readReviewRecord(stories, 's1'), { mark: { at: WHEN, by: 'manual' } });
  assert.equal(readReviewRecord(store({ [REVIEW_FILE]: [1] }), 's1'), null);
});

test('decided: a mark or unmark, or a standing approval; neither a lapsed one nor nothing', () => {
  assert.equal(isDecided(null), false);
  assert.equal(isDecided({ mark: { at: WHEN, by: 'review' } }), true);
  assert.equal(isDecided({ mark: { at: null, by: 'manual' } }), true);
  assert.equal(isDecided({ approval }), true);
  assert.equal(isDecided({ approval: { ...approval, lapsed: true } }), false);
});

test('the mark shown: the hand mark, else the counted approval as `approved`, else none', () => {
  assert.deepEqual(markOf({ mark: { at: WHEN, by: 'review' } }, null), { at: WHEN, by: 'review' });
  assert.deepEqual(markOf({ approval }, approval), { at: WHEN, by: 'approved' });
  assert.equal(markOf({ approval }, null), null, 'an approval that no longer counts');
  assert.deepEqual(markOf({ mark: { at: null, by: 'manual' }, approval }, approval), {
    at: WHEN,
    by: 'approved',
  });
  assert.deepEqual(
    markOf({ mark: { at: '2026-11-03T00:00:00.000Z', by: 'manual' }, approval }, approval),
    { at: '2026-11-03T00:00:00.000Z', by: 'manual' },
  );
});

test('the 7-day window reads the approval in review.json, and a carried approval counts at the commit it was given for', () => {
  const head = 'c'.repeat(40);
  const day = 24 * 3600 * 1000;
  const stories = store({
    [REVIEW_FILE]: {
      approval: {
        at: WHEN,
        head_oid: head,
        base_oid: null,
        carried: { from: 'd'.repeat(40), at: WHEN, run: 'fix-x' },
      },
    },
  });
  const when = Date.parse(WHEN);
  assert.equal(approvalOf(stories, 's1', head, when + 6 * day)?.head_oid, head);
  assert.equal(approvalOf(stories, 's1', 'd'.repeat(40), when + 6 * day)?.head_oid, head);
  assert.equal(approvalOf(stories, 's1', head, when + 8 * day), null);
  assert.equal(approvalOf(stories, 's1', 'e'.repeat(40), when + day), null);
});
