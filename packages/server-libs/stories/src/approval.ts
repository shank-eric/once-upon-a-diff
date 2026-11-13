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
  /** the branch moved on and the background check let go of this approval: it counts for nothing, but a fixer's commit on the card may still carry it */
  lapsed?: boolean;
  /** a fixer's commit (or its rebase, `via`) carried the approval to `head_oid` from `from`, the commit it was first given for (`at` stays the first approval's time, so APPROVED_DAYS counts from it) */
  carried?: { from: string; at: string; run: string; via?: 'rebase' };
}

/** Whether an approval is under APPROVED_DAYS old. */
export const approvalFresh = (found: Pick<Approval, 'at'>, now = Date.now()): boolean => {
  const approvedMs = Date.parse(found.at);
  return !Number.isNaN(approvedMs) && now - approvedMs <= APPROVED_DAYS * 24 * 3600 * 1000;
};

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
  // a carried approval also counts for the story as told at the commit it was first given for: a story pinned to its
  // told-over commits (`--head <branch>`) keeps that head while the approval moves with the fixer's commits
  if (
    !found ||
    found.lapsed ||
    !headOid ||
    (found.head_oid !== headOid && found.carried?.from !== headOid)
  ) {
    return null;
  }
  return approvalFresh(found, now) ? found : null;
}
