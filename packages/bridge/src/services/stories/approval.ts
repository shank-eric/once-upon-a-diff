/*
 * The read side of Approve on a local story: approved.json (<home>/state/<id>/approved.json), and whether the approval
 * still counts. It is story state, so the story's own code and the board read it from here; writing it (approveStory,
 * clearApproval) stays in review/approve.ts.
 */
import type { StoryStateReader } from './types.ts';

/** The story's own state file for its approval. */
export const APPROVAL_FILE = 'approved.json';
/** How long an approved local story with no PR stays approved (and in the board's Ready to ship). */
export const APPROVED_DAYS = 7;

/** What approved.json keeps. */
export interface Approval {
  at: string;
  head_oid: string;
  base_oid: string | null;
  /** approving wrote the story's reviewed mark */
  marked: boolean;
  /** the story had been unmarked by hand before approving, so unapproving puts that unmark back (else it clears the file) */
  unmarked?: boolean;
}

/** The raw approved.json, or null. */
export const readApproval = (stories: StoryStateReader, id: string): Approval | null =>
  stories.readState<Approval | null>(id, APPROVAL_FILE, null);

/**
 * The approval that still counts: it names the story's current head and is under APPROVED_DAYS old. `headOid` is the
 * story's head from its meta.json (kept current while a page polls the story, and by the background check).
 */
export function approvalOf(
  stories: StoryStateReader,
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
