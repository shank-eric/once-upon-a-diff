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
import type { Inbox } from '../inbox/inbox.ts';
import type { StoryRef } from '../stories/types.ts';
import type { StoryStore } from '../stories/store.ts';

const FILE = 'approved.json';
/** How long an approved local story with no PR stays approved (and in the board's Ready to ship). */
export const APPROVED_DAYS = 7;

/** What approved.json keeps. */
export interface Approval {
  at: string;
  head_oid: string;
  base_oid: string | null;
  /** approving wrote the story's reviewed mark */
  marked: boolean;
}

/** The raw approved.json, or null. */
export const readApproval = (stories: StoryStore, id: string): Approval | null =>
  stories.readState<Approval | null>(id, FILE, null);

/**
 * The approval that still counts: it names the story's current head and is under APPROVED_DAYS old. `headOid` is the
 * story's head from its meta.json (kept current while a page polls the story, and by the background check).
 */
export function approvalOf(
  stories: StoryStore,
  id: string,
  headOid: string | null | undefined,
  now = Date.now(),
): Approval | null {
  const found = readApproval(stories, id);
  if (!found || !headOid || found.head_oid !== headOid) {
    return null;
  }
  const approvedMs = Date.parse(found.at);
  return Number.isNaN(approvedMs) || now - approvedMs > APPROVED_DAYS * 24 * 3600 * 1000
    ? null
    : found;
}

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
  if (marked) {
    markStoryReviewed(stories, input.id, true, 'approved');
  }
  const approvedAt = new Date().toISOString();
  stories.writeState(input.id, FILE, {
    at: approvedAt,
    head_oid: input.headOid,
    base_oid: input.baseOid,
    marked: before ? before.marked || marked : marked,
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

/** Clears the approval, and the reviewed mark approving wrote (so the story is in Ready again). False when there was none. */
export function clearApproval(stories: StoryStore, id: string): boolean {
  const found = readApproval(stories, id);
  if (!found) {
    return false;
  }
  stories.writeState(id, FILE, null);
  if (found.marked && storyHasState(stories, id)) {
    markStoryReviewed(stories, id, false);
  }
  return true;
}
