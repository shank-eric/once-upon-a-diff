/*
 * The read side of Approve on a local story: the `approval` in the story's review record (review-record.ts), and whether
 * it still counts. It is story state, so the story's own code and the board read it from here; writing it (approveStory,
 * clearApproval) stays in review/approve.ts.
 */
import { commitOf } from '@once-upon-a-diff/adapters/git';
import { readReviewRecord, type Approval } from './review-record.ts';
import type { StoryStateReader } from './types.ts';

export type { Approval };

/** How long an approved local story with no PR stays approved (and in the board's Ready to ship). */
export const APPROVED_DAYS = 7;

/** Whether an approval is under APPROVED_DAYS old. */
export const approvalFresh = (found: Pick<Approval, 'at'>, now = Date.now()): boolean => {
  const approvedMs = Date.parse(found.at);
  return !Number.isNaN(approvedMs) && now - approvedMs <= APPROVED_DAYS * 24 * 3600 * 1000;
};

/** The record's approval, whether or not it has lapsed or aged out, or null. */
export const readApproval = (stories: StoryStateReader, id: string): Approval | null =>
  readReviewRecord(stories, id)?.approval ?? null;

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
  if (!found || found.lapsed || !headOid) {
    return null;
  }
  const namesHead = found.head_oid === headOid || found.carried?.from === headOid;
  return namesHead && approvalFresh(found, now) ? found : null;
}

/** The longest the board or a page waits on git for where a story's ref is. */
const TIP_TIMEOUT_MS = 3000;
/** How long a ref's answer is kept, so the board's polls and the page's polls share one git call. */
const TIP_KEEP_MS = 2000;
const tips = new Map<string, { at: number; tip: string | null }>();

/** Forgets the kept answers (a test that moves a branch and asks again at once). */
export const forgetTips = (): void => tips.clear();

/** Where the story's ref is now (null when git can't say, in time), asked once per TIP_KEEP_MS for a checkout and ref. */
function tipOf(repo: string, ref: string): string | null {
  const key = `${repo}\0${ref}`;
  const kept = tips.get(key);
  const asked = Date.now();
  if (kept && asked - kept.at < TIP_KEEP_MS) {
    return kept.tip;
  }
  const tip = commitOf(repo, ref, TIP_TIMEOUT_MS);
  tips.set(key, { at: asked, tip });
  return tip;
}

/**
 * `approvalOf`, also dropped when the story's ref (`meta.head`, in `meta.repo_path`) has left the approved commit.
 * meta.json's head_oid is only as current as the last page poll or background check, so a branch amended or moved
 * since the approval would still read as approved. A ref git can't resolve, or not within TIP_TIMEOUT_MS, leaves the
 * approval alone (the background check lets it go if the branch really moved). The board and the story page both say
 * this, so they agree.
 */
export function approvalAtTip(
  stories: StoryStateReader,
  id: string,
  meta: { head_oid?: unknown; head?: unknown; repo_path?: unknown },
  now = Date.now(),
): Approval | null {
  const counted = approvalOf(
    stories,
    id,
    typeof meta.head_oid === 'string' ? meta.head_oid : null,
    now,
  );
  if (!counted || typeof meta.repo_path !== 'string' || typeof meta.head !== 'string') {
    return counted;
  }
  const tip = tipOf(meta.repo_path, meta.head);
  return tip && tip !== counted.head_oid && tip !== counted.carried?.from ? null : counted;
}
