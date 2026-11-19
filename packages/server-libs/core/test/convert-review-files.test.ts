import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readReviewRecord } from '@once-upon-a-diff/stories/review-record';
import {
  convertReviewFiles,
  legacyReviewFolders,
} from '../src/orchestration/bridge/convert-review-files.ts';

const WHEN = '2026-11-01T10:00:00.000Z';
const approval = { at: WHEN, head_oid: 'a'.repeat(40), base_oid: null };

/** A home with story folders, each a map of state file name to its JSON. */
function homeWith(folders: Record<string, Record<string, unknown>>) {
  const home = tmp('convert-review-files');
  for (const [key, files] of Object.entries(folders)) {
    for (const [name, value] of Object.entries(files)) {
      writeJson(path.join(home, 'state', key, name), value);
    }
  }
  return { home, stories: new StoryStore({ home }) };
}
const has = (home: string, key: string, name: string) =>
  existsSync(path.join(home, 'state', key, name));

test('a reviewed.json is the mark, a hand unmark stays an unmark, a plain object reads manual', () => {
  const { home, stories } = homeWith({
    reviewed: { 'reviewed.json': { at: WHEN, by: 'review' } },
    plain: { 'reviewed.json': { at: WHEN } },
    unmarked: { 'reviewed.json': { at: null, by: 'manual' } },
  });
  assert.equal(convertReviewFiles(home), 3);
  assert.deepEqual(readReviewRecord(stories, 'reviewed'), { mark: { at: WHEN, by: 'review' } });
  assert.deepEqual(readReviewRecord(stories, 'plain'), { mark: { at: WHEN, by: 'manual' } });
  assert.deepEqual(readReviewRecord(stories, 'unmarked'), { mark: { at: null, by: 'manual' } });
  assert.equal(has(home, 'reviewed', 'reviewed.json'), false, 'the old file is deleted');
});

test('the mark Approve wrote is no mark of its own, unless the story had been unmarked before approving', () => {
  const approved = { ...approval, marked: true };
  const carried = { from: 'b'.repeat(40), at: WHEN, run: 'fix-x', via: 'rebase' as const };
  const { home, stories } = homeWith({
    plain: { 'approved.json': approved, 'reviewed.json': { at: WHEN, by: 'approved' } },
    unmarked: {
      'approved.json': { ...approved, unmarked: true },
      'reviewed.json': { at: WHEN, by: 'approved' },
    },
    // a hand mark kept under an approval keeps its by
    kept: {
      'approved.json': { ...approval, marked: false },
      'reviewed.json': { at: WHEN, by: 'review' },
    },
    // lapsed and carried ride along; marked and unmarked do not
    carried: { 'approved.json': { ...approved, lapsed: true, carried } },
  });
  assert.equal(convertReviewFiles(home), 4);
  assert.deepEqual(readReviewRecord(stories, 'plain'), { approval });
  assert.deepEqual(readReviewRecord(stories, 'unmarked'), {
    mark: { at: null, by: 'manual' },
    approval,
  });
  assert.deepEqual(readReviewRecord(stories, 'kept'), {
    mark: { at: WHEN, by: 'review' },
    approval,
  });
  assert.deepEqual(readReviewRecord(stories, 'carried'), {
    approval: { ...approval, lapsed: true, carried },
  });
  assert.equal(has(home, 'plain', 'approved.json'), false);
});

test('a stale approved mark with no approved.json, and files that hold null, make no review.json but are removed', () => {
  const { home } = homeWith({
    stale: { 'reviewed.json': { at: WHEN, by: 'approved' } },
    emptied: { 'reviewed.json': null, 'approved.json': null },
  });
  assert.deepEqual(legacyReviewFolders(home).sort(), ['emptied', 'stale']);
  assert.equal(convertReviewFiles(home), 2);
  for (const key of ['stale', 'emptied']) {
    assert.equal(has(home, key, 'review.json'), false);
    assert.equal(has(home, key, 'reviewed.json'), false);
    assert.equal(has(home, key, 'approved.json'), false);
  }
  assert.deepEqual(legacyReviewFolders(home), []);
});

test('review.json wins over the old files beside it, which only fill a facet it lacks', () => {
  const { home, stories } = homeWith({
    s1: {
      'review.json': { mark: { at: WHEN, by: 'manual' } },
      'reviewed.json': { at: '2026-11-02T00:00:00.000Z', by: 'review' },
      'approved.json': approval,
    },
  });
  convertReviewFiles(home);
  assert.deepEqual(readReviewRecord(stories, 's1'), { mark: { at: WHEN, by: 'manual' }, approval });
  assert.equal(has(home, 's1', 'reviewed.json'), false);
  assert.equal(has(home, 's1', 'approved.json'), false);
});

test('a folder with only review.json, and a home with no state, are left alone', () => {
  const { home, stories } = homeWith({ s1: { 'review.json': { approval } } });
  assert.equal(convertReviewFiles(home), 0);
  assert.deepEqual(readReviewRecord(stories, 's1'), { approval });
  assert.equal(convertReviewFiles(tmp('convert-review-files-empty')), 0);
});
