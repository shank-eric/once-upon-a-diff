/**
 * Approve on a local story: "this is ready to ship". It is the `approval` in the story's review record, <home>/state/<id>/
 * review.json: {at, head_oid, base_oid}, written by the page's Approve button and `once-upon approve`. It names the head it
 * approved, so it counts only while the story's head is that commit (a new commit clears it: `approvalOf` on read,
 * `AutoReview.kickLocal` on disk), and for APPROVED_DAYS at most.
 *
 * An approval that counts also shows the story as reviewed (by `approved`, derived from it: stories/src/review-record.ts
 * `markOf`), so it leaves Ready for your review, and clearing the approval takes that away and the story returns to Ready.
 * The story's own mark, hand made or a check's, is a separate part of the record: approving and clearing never touch it.
 */
import { updateReviewRecord } from './review-record.ts';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import type { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import type { StoryRef } from '@once-upon-a-diff/stories/types';
import type { StoryStore } from '@once-upon-a-diff/stories/store';
/** What the event tells a listener about the story. */
export interface ApproveInput {
  id: string;
  ref: StoryRef;
  branch: string | null;
  checkout: string | null;
  base: string | null;
  headOid: string;
  baseOid: string | null;
  /** the story's own head when `headOid` is its branch's tip after a rebase of the story's commits: the approval is recorded as carried from it */
  rebasedFrom?: string;
}

/**
 * Approves the story at its head. Returns false (and does nothing) when it is already approved at that head. Otherwise
 * writes the approval into the record and appends the `approved` event.
 */
export function approveStory(stories: StoryStore, inbox: Inbox, input: ApproveInput): boolean {
  const prior = readApproval(stories, input.id);
  // a lapsed approval is no approval: this one starts fresh, without its `lapsed` or `carried`
  const before = prior?.lapsed ? null : prior;
  // (a carried approval is also the approval of the story as told at the commit it was first given for)
  if (before && (before.head_oid === input.headOid || before.carried?.from === input.headOid)) {
    return false;
  }
  // the line is checked before anything is saved: a refusal is then an approval that never happened
  const entry = {
    type: 'approved' as const,
    ...input.ref,
    story: input.id,
    branch: input.branch,
    checkout: input.checkout,
    base: input.base,
    head_sha: input.headOid,
  };
  inbox.check(entry);
  updateReviewRecord(stories, input.id, (record) => {
    record.approval = {
      at: new Date().toISOString(),
      head_oid: input.headOid,
      base_oid: input.baseOid,
      ...(input.rebasedFrom && {
        carried: {
          from: input.rebasedFrom,
          at: new Date().toISOString(),
          run: '',
          via: 'rebase' as const,
        },
      }),
    };
  });
  inbox.append(entry);
  return true;
}

/**
 * Clears the approval (the story is in Ready again unless it has a mark). False when there was none. `lapsed` is for the
 * background check, when the branch moved: the approval stays in the record, marked `lapsed`, so a fixer's commit on the card
 * can still carry it (carry-approval.ts); an explicit clear (`--undo`, Approve off) deletes it, so it is never carried. The
 * story's mark is not touched either way.
 */
export function clearApproval(
  stories: StoryStore,
  id: string,
  { lapsed = false }: { lapsed?: boolean } = {},
): boolean {
  return updateReviewRecord(stories, id, (record) => {
    if (!record.approval) {
      return false;
    }
    if (lapsed) {
      record.approval = { ...record.approval, lapsed: true };
    } else {
      delete record.approval;
    }
    return true;
  });
}
