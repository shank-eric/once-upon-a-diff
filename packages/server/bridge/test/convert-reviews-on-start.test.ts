/*
 * The bridge folds a story's old reviewed.json and approved.json into review.json as it starts (createBridge runs
 * convert-review-files.ts), so a home from before review.json reads as reviewed and approved right away, with no `doctor --fix`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { tmp, writeJson, startBridge } from './helpers.ts';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readReviewRecord } from '@once-upon-a-diff/stories/review-record';

const WHEN = '2026-11-01T10:00:00.000Z';
const approval = { at: WHEN, head_oid: 'a'.repeat(40), base_oid: null };

test('a home with only reviewed.json and approved.json reads as reviewed and approved right after the bridge starts', async () => {
  const home = tmp('convert-on-start');
  writeJson(path.join(home, 'state', 'old', 'reviewed.json'), { at: WHEN, by: 'review' });
  writeJson(path.join(home, 'state', 'old', 'approved.json'), approval);
  const bridge = await startBridge({ home });
  try {
    assert.deepEqual(readReviewRecord(new StoryStore({ home }), 'old'), {
      mark: { at: WHEN, by: 'review' },
      approval,
    });
    assert.equal(existsSync(path.join(home, 'state', 'old', 'reviewed.json')), false);
    assert.equal(existsSync(path.join(home, 'state', 'old', 'approved.json')), false);
  } finally {
    await bridge.close();
  }
});

test('a review.json already in the folder wins over the old files when the bridge starts', async () => {
  const home = tmp('convert-on-start-wins');
  const mark = { at: '2026-11-03T00:00:00.000Z', by: 'manual' };
  writeJson(path.join(home, 'state', 'both', 'review.json'), { mark });
  writeJson(path.join(home, 'state', 'both', 'reviewed.json'), { at: WHEN, by: 'review' });
  writeJson(path.join(home, 'state', 'both', 'approved.json'), approval);
  const bridge = await startBridge({ home });
  try {
    assert.deepEqual(readReviewRecord(new StoryStore({ home }), 'both'), { mark, approval });
  } finally {
    await bridge.close();
  }
});
