import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readReviewRecord } from '@once-upon-a-diff/stories/review-record';
import { updateReviewRecord } from '../src/features/review/review-record.ts';
import { clearApproval } from '../src/features/review/approve.ts';
import { markStoryReviewed, storyHasState } from '../src/features/review/story-lists.ts';

const WHEN = '2026-11-01T10:00:00.000Z';
const approval = { at: WHEN, head_oid: 'a'.repeat(40), base_oid: null };

/** A home with a story's legacy files (or review.json) in place. */
function home(files: Record<string, unknown>) {
  const dir = tmp('review-record-core');
  for (const [name, value] of Object.entries(files)) {
    writeJson(path.join(dir, 'state', 's1', name), value);
  }
  return { dir, stories: new StoryStore({ home: dir }) };
}
const file = (dir: string, name: string) => path.join(dir, 'state', 's1', name);

test('the first write on a legacy folder saves review.json and empties the old files', () => {
  const { dir, stories } = home({
    'reviewed.json': { at: WHEN, by: 'review' },
    'approved.json': { ...approval, marked: false },
  });
  markStoryReviewed(stories, 's1', false);
  assert.deepEqual(stories.readState('s1', 'review.json', null), {
    mark: { at: null, by: 'manual', head_oid: null },
    approval,
  });
  assert.equal(stories.readState('s1', 'reviewed.json', null), null);
  assert.equal(stories.readState('s1', 'approved.json', null), null);
  assert.equal(existsSync(`${file(dir, 'review.json')}.lock`), false, 'the lock is let go');
});

test('a write to a folder with only a stale approved mark leaves no mark behind, and the story is not decided', () => {
  const { stories } = home({ 'reviewed.json': { at: WHEN, by: 'approved' } });
  assert.equal(storyHasState(stories, 's1'), false);
  updateReviewRecord(stories, 's1', () => undefined);
  assert.equal(stories.readState('s1', 'review.json', null), null);
  assert.equal(stories.readState('s1', 'reviewed.json', null), null, 'emptied');
});

test('a mark, then an approval, then a lapse keeps both parts; a lapsed approval is not a decision', () => {
  const { stories } = home({});
  markStoryReviewed(stories, 's1', true, 'review', 'b'.repeat(40));
  updateReviewRecord(stories, 's1', (record) => {
    record.approval = approval;
  });
  assert.equal(clearApproval(stories, 's1', { lapsed: true }), true);
  assert.deepEqual(readReviewRecord(stories, 's1'), {
    mark: {
      at: readReviewRecord(stories, 's1')?.mark?.at as string,
      by: 'review',
      head_oid: 'b'.repeat(40),
    },
    approval: { ...approval, lapsed: true },
  });
  assert.equal(clearApproval(stories, 's1'), true);
  assert.equal(readReviewRecord(stories, 's1')?.approval, undefined);
  assert.equal(
    readReviewRecord(stories, 's1')?.mark?.by,
    'review',
    'the mark outlives the approval',
  );
  assert.equal(clearApproval(stories, 's1'), false, 'nothing left to clear');

  const lapsedOnly = home({ 'review.json': { approval: { ...approval, lapsed: true } } });
  assert.equal(storyHasState(lapsedOnly.stories, 's1'), false);
});

test('a lapse note is stored with the lapse, and a re-approval or an undo leaves none', () => {
  const { stories } = home({});
  const lapse = {
    at: WHEN,
    tip: 'c'.repeat(40),
    changes: [{ kind: 'dropped' as const, sha: 'a'.repeat(40), subject: 'one' }],
  };
  updateReviewRecord(stories, 's1', (record) => {
    record.approval = approval;
  });
  assert.equal(clearApproval(stories, 's1', { lapsed: true, lapse }), true);
  assert.deepEqual(readReviewRecord(stories, 's1')?.approval, { ...approval, lapsed: true, lapse });
  assert.equal(clearApproval(stories, 's1'), true);
  assert.equal(readReviewRecord(stories, 's1')?.approval, undefined);
  updateReviewRecord(stories, 's1', (record) => {
    record.approval = approval;
  });
  assert.equal(clearApproval(stories, 's1', { lapsed: true, lapse: null }), true);
  assert.deepEqual(readReviewRecord(stories, 's1')?.approval, { ...approval, lapsed: true });
});

test('a legacy file written after review.json exists (an old bridge) is not lost by the next write', () => {
  const { stories } = home({ 'review.json': { approval } });
  writeJson(path.join(stories.home, 'state', 's1', 'reviewed.json'), {
    at: WHEN,
    by: 'all viewed',
  });
  assert.equal(readReviewRecord(stories, 's1')?.mark?.by, 'all viewed');
  updateReviewRecord(stories, 's1', () => undefined);
  assert.deepEqual(stories.readState('s1', 'review.json', null), {
    mark: { at: WHEN, by: 'all viewed' },
    approval,
  });
  assert.equal(stories.readState('s1', 'reviewed.json', null), null);
});

test('a change that leaves the record as it was writes nothing; an emptied record is saved as null', () => {
  const { dir, stories } = home({});
  updateReviewRecord(stories, 's1', () => undefined);
  assert.equal(existsSync(file(dir, 'review.json')), false);
  markStoryReviewed(stories, 's1');
  updateReviewRecord(stories, 's1', (record) => {
    delete record.mark;
  });
  assert.equal(stories.readState('s1', 'review.json', null), null);
});
