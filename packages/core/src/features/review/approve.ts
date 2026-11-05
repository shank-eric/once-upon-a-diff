/**
 * Approve on a local story: "this is ready to ship". It is the story's own state file, <home>/state/<id>/approved.json:
 * {at, head_oid, base_oid, marked}, written by the page's Approve button and `once-upon approve`. It names the head it
 * approved, so it counts only while the story's head is that commit (a new commit clears it: `approvalOf` on read,
 * `AutoReview.kickLocal` on disk), and for APPROVED_DAYS at most.
 *
 * Approving also marks the story reviewed (reviewed.json, by `approved`), so it leaves Ready for your review. `marked`
 * says approving wrote that mark, so clearing the approval takes it back and the story returns to Ready. A story you had
 * already marked reviewed keeps that mark.
 */
import { markStoryReviewed, storyHasState } from './story-lists.ts';
import { APPROVAL_FILE, readApproval, type Approval } from '../../records/stories/approval.ts';
import type { Inbox } from '../../queues/requests/inbox.ts';
import type { StoryRef } from '../../records/stories/types.ts';
import type { StoryStore } from '../../records/stories/store.ts';

/** What the event tells a listener about the story. */
export interface ApproveInput {
  id: string;
  ref: StoryRef;
  branch: string | null;
  checkout: string | null;
  base: string | null;
  headOid: string;
  baseOid: string | null;
}

/**
 * Approves the story at its head. Returns false (and does nothing) when it is already approved at that head. Otherwise
 * writes approved.json, marks the story reviewed unless it already is, and appends the `approved` event.
 */
export function approveStory(stories: StoryStore, inbox: Inbox, input: ApproveInput): boolean {
  const before = readApproval(stories, input.id);
  if (before && before.head_oid === input.headOid) {
    return false;
  }
  const state = stories.readState<{ at?: string | null } | null>(input.id, 'reviewed.json', null);
  const marked = !state?.at;
  const unmarked = before ? before.unmarked : state !== null && !state.at;
  if (marked) {
    markStoryReviewed(stories, input.id, true, 'approved');
  }
  const approvedAt = new Date().toISOString();
  stories.writeState(input.id, APPROVAL_FILE, {
    at: approvedAt,
    head_oid: input.headOid,
    base_oid: input.baseOid,
    marked: before ? before.marked || marked : marked,
    ...(unmarked ? { unmarked: true } : {}),
  } satisfies Approval);
  inbox.append({
    type: 'approved',
    ...input.ref,
    story: input.id,
    branch: input.branch,
    checkout: input.checkout,
    base: input.base,
    head_sha: input.headOid,
  });
  return true;
}

/**
 * Clears the approval, and the reviewed mark approving wrote (so the story is in Ready again). False when there was none.
 * The mark goes back to how it was before approving: no file at all, so the background checks can still find the story
 * delivered or its PR merged, unless it had been unmarked by hand (that unmark returns).
 */
export function clearApproval(stories: StoryStore, id: string): boolean {
  const found = readApproval(stories, id);
  if (!found) {
    return false;
  }
  stories.writeState(id, APPROVAL_FILE, null);
  if (found.marked && storyHasState(stories, id)) {
    if (found.unmarked) {
      markStoryReviewed(stories, id, false);
    } else {
      stories.writeState(id, 'reviewed.json', null);
    }
  }
  return true;
}
