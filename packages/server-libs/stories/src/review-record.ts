/*
 * A story's review record: one file, <home>/state/<story id>/review.json, for what the reviewer and the checks have
 * decided about it. It holds two facets, and nothing in one overwrites the other:
 *   - `mark`: the story's done mark: who made it (`by`: manual, review, all viewed, pr, delivered), when (`at`, null for
 *     an unmark by hand, which is a decision too: the checks leave the story alone), and the commit it applied to
 *     (`head_oid`, kept by the writers that know it: a local story's marks, not a PR story's);
 *   - `approval`: Approve on a local story, with the head it names (`head_oid`), the time it was first given and the
 *     lapse (with what changed on the branch, when it could be compared) and carry bookkeeping (approval.ts says what
 *     counts).
 * This module and core's `review/review-record.ts` (the writer) are the only code that knows the file's name and the
 * story key it lives under. It replaced reviewed.json and approved.json, which `once-upon doctor --fix` converts
 * (core's `orchestration/bridge/convert-review-files.ts`); nothing here reads them.
 */
import type { LocalLapse, LocalLapseChange } from '@once-upon-a-diff/contracts/types';
import type { StoryStateReader } from './types.ts';

/** The story's own state file for its review record. */
export const REVIEW_FILE = 'review.json';

/** What a stored mark can say made it. (`approved` is derived from the approval, never stored.) */
export type MarkBy = 'manual' | 'review' | 'all viewed' | 'pr' | 'delivered';
const MARK_BYS: readonly string[] = ['manual', 'review', 'all viewed', 'pr', 'delivered'];

/** The story's done mark. */
export interface ReviewMark {
  /** null: unmarked by hand */
  at: string | null;
  by: MarkBy;
  /** the commit the mark applied to, where the writer knew it */
  head_oid?: string | null;
}

/** Approve on a local story. */
export interface Approval {
  at: string;
  head_oid: string;
  base_oid: string | null;
  /** the branch moved on and the background check let go of this approval: it counts for nothing, but a fixer's commit on the card may still carry it */
  lapsed?: boolean;
  /** with `lapsed`: the commits that changed, when they could be compared (never stored with no changes) */
  lapse?: LocalLapse;
  /** a fixer's commit (or its rebase, `via`) carried the approval to `head_oid` from `from`, the commit it was first given for (`at` stays the first approval's time, so APPROVED_DAYS counts from it) */
  carried?: { from: string; at: string; run: string; via?: 'rebase' };
}

export interface ReviewRecord {
  mark?: ReviewMark;
  approval?: Approval;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function readMark(raw: unknown): ReviewMark | undefined {
  if (!isObject(raw) || (raw.at !== null && typeof raw.at !== 'string')) {
    return undefined;
  }
  const mark: ReviewMark = {
    at: raw.at,
    by: typeof raw.by === 'string' && MARK_BYS.includes(raw.by) ? (raw.by as MarkBy) : 'manual',
  };
  if (typeof raw.head_oid === 'string' || raw.head_oid === null) {
    mark.head_oid = raw.head_oid;
  }
  return mark;
}

const CHANGE_KINDS: readonly string[] = ['added', 'dropped', 'edited', 'reordered'];
const MAX_LAPSE_CHANGES = 30;

type StoredLapseChange = Record<string, unknown> & { kind: string; sha: string; subject: string };

/** Whether a stored value is one change of a lapse note: a known kind with its commit and subject. */
export const isStoredLapseChange = (item: unknown): item is StoredLapseChange => {
  if (!isObject(item)) {
    return false;
  }
  const hasKnownKind = typeof item.kind === 'string' && CHANGE_KINDS.includes(item.kind);
  const hasCommit = typeof item.sha === 'string';
  const hasSubject = typeof item.subject === 'string';
  return hasKnownKind && hasCommit && hasSubject;
};

/** A stored lapse change as the record keeps it: the kind, commit and subject, and `was` when it is text. */
const lapseChangeOf = (item: StoredLapseChange): LocalLapseChange => ({
  kind: item.kind as LocalLapseChange['kind'],
  sha: item.sha,
  subject: item.subject,
  ...(typeof item.was === 'string' && { was: item.was }),
});

/** How many more changes a lapse note says there were: a whole number above zero, else 0. */
const moreOf = (value: unknown): number =>
  typeof value === 'number' && value > 0 ? Math.floor(value) : 0;

/** A stored lapse note, or undefined when it is malformed or names no change. */
function readLapse(raw: unknown): LocalLapse | undefined {
  if (!isObject(raw) || typeof raw.at !== 'string' || typeof raw.tip !== 'string') {
    return undefined;
  }
  const stored: unknown[] = Array.isArray(raw.changes)
    ? raw.changes.slice(0, MAX_LAPSE_CHANGES)
    : [];
  const changes = stored.filter(isStoredLapseChange).map(lapseChangeOf);
  const more = moreOf(raw.more);
  return changes.length ? { at: raw.at, tip: raw.tip, changes, ...(more && { more }) } : undefined;
}

/** Whether a stored value is a commit id or the absence of one (null or missing). */
export const isOptionalOid = (value: unknown): value is string | null | undefined =>
  value === null || value === undefined || typeof value === 'string';

function readApprovalFacet(raw: unknown): Approval | undefined {
  if (
    !isObject(raw) ||
    typeof raw.at !== 'string' ||
    typeof raw.head_oid !== 'string' ||
    !isOptionalOid(raw.base_oid)
  ) {
    return undefined;
  }
  const approval: Approval = {
    at: raw.at,
    head_oid: raw.head_oid,
    base_oid: typeof raw.base_oid === 'string' ? raw.base_oid : null,
  };
  if (raw.lapsed === true) {
    approval.lapsed = true;
    const lapse = readLapse(raw.lapse);
    if (lapse) {
      approval.lapse = lapse;
    }
  }
  const carried = raw.carried;
  if (
    isObject(carried) &&
    typeof carried.from === 'string' &&
    typeof carried.at === 'string' &&
    typeof carried.run === 'string'
  ) {
    approval.carried = {
      from: carried.from,
      at: carried.at,
      run: carried.run,
      ...(carried.via === 'rebase' && { via: 'rebase' as const }),
    };
  }
  return approval;
}

const orNull = (record: ReviewRecord): ReviewRecord | null =>
  record.mark || record.approval ? record : null;

/** A stored review.json's value as a record (a field it can't read is absent, an unknown one is dropped), or null. */
export function parseReviewRecord(raw: unknown): ReviewRecord | null {
  if (!isObject(raw)) {
    return null;
  }
  const mark = readMark(raw.mark);
  const approval = readApprovalFacet(raw.approval);
  return orNull({ ...(mark && { mark }), ...(approval && { approval }) });
}

/** The story's review record, or null. Reading writes nothing. */
export function readReviewRecord(stories: StoryStateReader, key: string): ReviewRecord | null {
  return parseReviewRecord(stories.readState<unknown>(key, REVIEW_FILE, null));
}

/**
 * Whether the reviewer or a check has decided about the story, so the checks leave it alone: it has a mark (or a hand
 * unmark), or an approval that has not lapsed. A lapsed approval is no decision: the checks may mark the story again.
 */
export const isDecided = (record: ReviewRecord | null): boolean =>
  !!record && (record.mark !== undefined || (!!record.approval && !record.approval.lapsed));

/**
 * The done mark to show: the story's own mark when it has one, else its approval (`counted`, the one that still counts)
 * as `approved`, else none.
 */
export function markOf(
  record: ReviewRecord | null,
  counted: Approval | null,
): { at: string; by: MarkBy | 'approved' } | null {
  if (record?.mark?.at) {
    return { at: record.mark.at, by: record.mark.by };
  }
  return counted ? { at: counted.at, by: 'approved' } : null;
}
