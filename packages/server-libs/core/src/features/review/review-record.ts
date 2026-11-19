/*
 * The write side of a story's review record (stories/src/review-record.ts says what it holds): every writer (the mark,
 * Approve and its undo, a fixer's carry, the checks) goes through updateReviewRecord, so a mark and an approval made at the
 * same moment by the CLI and the bridge are one read-modify-write under review.json's lock, not two files that cannot lose
 * each other's change.
 */
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { stateFile } from '@once-upon-a-diff/foundation/settings';
import {
  REVIEW_FILE,
  readReviewRecord,
  type ReviewRecord,
} from '@once-upon-a-diff/stories/review-record';
import type { StoryStore } from '@once-upon-a-diff/stories/store';

/**
 * Lets `change` change the story's record (an empty one when it has none) and saves it, null when neither facet is left.
 * Returns what `change` returns. A change that leaves the record as it was writes nothing.
 */
export function updateReviewRecord<R>(
  stories: StoryStore,
  key: string,
  change: (record: ReviewRecord) => R,
): R {
  return withLock(stateFile(stories.home, key, REVIEW_FILE), () => {
    const before = readReviewRecord(stories, key);
    const record: ReviewRecord = structuredClone(before ?? {});
    const result = change(record);
    const after = record.mark || record.approval ? record : null;
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      stories.writeState(key, REVIEW_FILE, after);
    }
    return result;
  });
}
