import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { REVIEW_FILE, isDecided, markOf, readReviewRecord } from '../src/review-record.ts';
import { approvalOf } from '../src/approval.ts';
import { StoryStore } from '../src/store.ts';

const WHEN = '2026-11-01T10:00:00.000Z';
const approval = { at: WHEN, head_oid: 'a'.repeat(40), base_oid: null };

function store(files: Record<string, unknown>) {
  const home = tmp('review-record');
  for (const [name, value] of Object.entries(files)) {
    writeJson(path.join(home, 'state', 's1', name), value);
  }
  return new StoryStore({ home });
}

test('review.json is read, a missing or null one is no record, and a read writes nothing', () => {
  const now = store({ [REVIEW_FILE]: { mark: { at: WHEN, by: 'all viewed' }, approval } });
  assert.deepEqual(readReviewRecord(now, 's1'), {
    mark: { at: WHEN, by: 'all viewed' },
    approval,
  });
  const nulled = store({ [REVIEW_FILE]: null, 'reviewed.json': { at: WHEN, by: 'pr' } });
  assert.equal(readReviewRecord(nulled, 's1'), null, 'the old files are not read');
  assert.equal(readReviewRecord(store({}), 's1'), null);
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

test('a lapse note round-trips with its lapsed approval, and a malformed or empty one is dropped while the approval stays', () => {
  const lapse = {
    at: WHEN,
    tip: 'c'.repeat(40),
    changes: [{ kind: 'edited', sha: 'c'.repeat(40), subject: 'add two', was: 'a'.repeat(40) }],
    more: 2,
  };
  const lapsed = { ...approval, lapsed: true };
  assert.deepEqual(
    readReviewRecord(store({ [REVIEW_FILE]: { approval: { ...lapsed, lapse } } }), 's1'),
    {
      approval: { ...lapsed, lapse },
    },
  );
  const bad = [
    { ...lapse, tip: 7 },
    { ...lapse, changes: [] },
    { ...lapse, changes: [{ kind: 'moved', sha: 'x', subject: 'y' }] },
    'nope',
  ];
  for (const one of bad) {
    assert.deepEqual(
      readReviewRecord(store({ [REVIEW_FILE]: { approval: { ...lapsed, lapse: one } } }), 's1'),
      {
        approval: lapsed,
      },
    );
  }
  // a note on an approval that has not lapsed is not read
  assert.deepEqual(
    readReviewRecord(store({ [REVIEW_FILE]: { approval: { ...approval, lapse } } }), 's1'),
    {
      approval,
    },
  );
});

test('a lapse note keeps its first 30 well-formed changes, drops the rest, and reads `more` as a whole number above zero', () => {
  const sha = 'c'.repeat(40);
  const change = (index: number) => ({ kind: 'added', sha, subject: `change ${index}` });
  const lapsed = { ...approval, lapsed: true };
  const readLapse = (lapse: object) =>
    readReviewRecord(store({ [REVIEW_FILE]: { approval: { ...lapsed, lapse } } }), 's1')?.approval
      ?.lapse;
  const many = readLapse({
    at: WHEN,
    tip: sha,
    changes: [{ kind: 'added', sha }, ...Array.from({ length: 35 }, (_, index) => change(index))],
    more: 2.7,
  });
  // the malformed first item is skipped but still counts toward the 30 read
  assert.equal(many?.changes.length, 29);
  assert.equal(many?.changes[0]?.subject, 'change 0');
  assert.equal(many?.more, 2);
  for (const more of [0, -3, '4', null]) {
    assert.equal(readLapse({ at: WHEN, tip: sha, changes: [change(1)], more })?.more, undefined);
  }
  assert.equal(readLapse({ at: WHEN, tip: sha })?.changes, undefined);
});
