/*
 * `once-upon doctor --fix`, one step: the stories told before review.json still have the two files it replaced,
 * reviewed.json (the done mark) and approved.json (Approve). This writes the record they make into review.json and
 * removes them. Nothing else reads them any more, so a story folder that is not converted shows as not reviewed. The bridge
 * runs it at start; `once-upon doctor --fix` is the manual path.
 * Once `legacyReviewFolders` reports none on the machine, this file and its doctor lines can go.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { removeFile } from '@once-upon-a-diff/adapters/stores/fs/files';
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { stateFile } from '@once-upon-a-diff/foundation/settings';
import { parseReviewRecord, REVIEW_FILE } from '@once-upon-a-diff/stories/review-record';
import { StoryStore } from '@once-upon-a-diff/stories/store';

const REVIEWED_FILE = 'reviewed.json';
const APPROVED_FILE = 'approved.json';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The state folders (story keys) that still hold reviewed.json or approved.json, even one that holds only `null`. */
export function legacyReviewFolders(home: string): string[] {
  let keys: string[];
  try {
    keys = readdirSync(path.join(home, 'state'));
  } catch {
    return [];
  }
  return keys.filter((key) =>
    [REVIEWED_FILE, APPROVED_FILE].some((name) => existsSync(stateFile(home, key, name))),
  );
}

/**
 * The record a reviewed.json and approved.json make together. A hand unmark made before approving is kept as an unmark, and
 * a mark that says `approved` is the approval's own, so it is no mark.
 */
function recordOfPair(reviewed: unknown, approved: unknown) {
  const done = isObject(reviewed) ? reviewed : null;
  const approval = isObject(approved) ? approved : null;
  let mark: unknown;
  if (done && done.by !== 'approved') {
    mark = { at: done.at ?? null, by: done.by ?? 'manual' };
  } else if (done && approval?.unmarked) {
    mark = { at: null, by: 'manual' };
  }
  return parseReviewRecord({ mark, approval });
}

/**
 * Converts every state folder that has the old pair: review.json gets the record they make (review.json is the newer record, so the old
 * files only fill a facet it lacks), then they are removed. Returns how many folders
 * it converted. A folder with none of them is left alone.
 */
export function convertReviewFiles(home: string): number {
  const stories = new StoryStore({ home });
  const keys = legacyReviewFolders(home);
  for (const key of keys) {
    withLock(stateFile(home, key, REVIEW_FILE), () => {
      const stored = parseReviewRecord(stories.readState<unknown>(key, REVIEW_FILE, null));
      const legacy = recordOfPair(
        stories.readState<unknown>(key, REVIEWED_FILE, null),
        stories.readState<unknown>(key, APPROVED_FILE, null),
      );
      const mark = stored?.mark ?? legacy?.mark;
      const approval = stored?.approval ?? legacy?.approval;
      if (legacy && (mark || approval)) {
        stories.writeState(key, REVIEW_FILE, {
          ...(mark && { mark }),
          ...(approval && { approval }),
        });
      }
      removeFile(stateFile(home, key, REVIEWED_FILE));
      removeFile(stateFile(home, key, APPROVED_FILE));
    });
  }
  return keys.length;
}
