/*
 * The review loop's answers: questions and their answers, the drafted comments, and the fixes a reviewer sends back.
 * Types only: nothing here runs.
 */

import type { Side } from '@once-upon-a-diff/terms/line-refs';
import type { ChapterRef, LocalNote } from '../story/types.ts';

export interface Answer {
  id?: string;
  at: string;
  text: string;
  by?: string | null;
  /** the places the text links to (`[text](ref:<id>)`), as in a chapter */
  refs?: ChapterRef[];
}

export interface Question {
  id: string;
  at: string;
  step: number;
  text: string;
  file: string | null;
  dismissed?: boolean;
  collapsed?: boolean;
  handed_to?: string | null;
  /** asked by voice, not typed in the Ask box */
  channel?: 'voice' | null;
  /** it has an answer you haven't read (the bridge keeps what you read, so this holds across reloads and pages) */
  unread?: boolean;
  /** Mark unread held it: looking at the answer doesn't read it again until Mark read or Mark all read */
  held?: boolean;
  /** when you last read its answer */
  read_at?: string | null;
  /** where a question with no answer stands: queued, a session working on it, or one that went quiet */
  status?: QuestionStatus | null;
  answers: Answer[];
}

/** What a session has said about the question it is answering. */
export interface QuestionStatus {
  state: 'queued' | 'relaying' | 'working' | 'stalled';
  /** the session working on it */
  by: string | null;
  /** the session that relayed it to `by`, the agent that built the story */
  via?: string | null;
  /** when it took the question */
  since: string | null;
  /** what it said it is doing (once-upon asking) */
  note: string | null;
  note_at: string | null;
}

/** What a read adds to its mark: the newest answer the panel drew for each question, and whether the panel did it by itself. */
export interface QuestionMarkExtra {
  seen?: Record<string, string>;
  auto?: boolean;
}

/** A question as the Ask box sends it. */
export interface QuestionAsk {
  text: string;
  step: number;
  chapter: string;
  file: string | null;
}

export type QuestionMark =
  'dismiss' | 'restore' | 'collapse' | 'expand' | 'clear' | 'read' | 'unread' | 'read_all';

export interface QuestionMarksAnswer {
  questions: Question[];
  /** the ids a clear dismissed, so Undo can bring back just those */
  cleared?: string[];
}

/** How far a draft's fix-before-push note has got. */
export interface DraftFix {
  id?: string;
  path: string;
  side: Side;
  line: number;
  state: 'draft' | 'sent' | 'fixed';
  sha?: string | null;
  sent_to?: string | null;
  done?: boolean;
}

/** Add to my review's mark on a draft. */
export interface DraftAdded {
  at: string;
  url?: string | null;
  started?: boolean;
}

/** One drafted comment's state, from the bridge (what gh finds on the PR, and the reviewer's marks). */
export interface DraftRow {
  chapter: number;
  index: number;
  key?: string;
  status: 'draft' | 'posted' | 'pending';
  dismissed: boolean;
  url?: string | null;
  source?: string | null;
  /** how close the matched GitHub comment is, 0..1 */
  score?: number | null;
  added?: DraftAdded | null;
  fix?: DraftFix | null;
}

export type DraftAction = 'dismiss' | 'restore' | 'review' | 'fix' | 'settle';

export interface DraftsAnswer {
  drafts: DraftRow[];
  error?: string | null;
  added?: DraftAdded | null;
}

/** A fix-before-push note: a story's note (notes.json) and how far it has got. */
export interface FixNote extends LocalNote {
  state: 'draft' | 'sent' | 'fixed';
}

/** A fix request: the notes one Send handed to a session. */
export interface FixRequestView {
  id: string;
  status: string;
  notes: string[];
  to?: string | null;
  claimed_by?: string | null;
}

/** Fix before push as the panel shows it. */
export interface FixesView {
  notes: FixNote[];
  auto_send: boolean;
  /** the session a send goes to now, if one takes fix requests for the story */
  to: { consumer: string } | null;
  requests: FixRequestView[];
  /** after a send: who got it */
  sent?: { to: string | null } | null;
  /**
   * New notes can be added: a local story always, a PR story only the viewer's own. When false the panel hides the
   * Fix before push tools and Add to fix before push, and keeps notes already there readable. Missing means true.
   */
  can_add?: boolean;
}

export type FixesAct =
  | { action: 'send' }
  | { action: 'auto'; on: boolean }
  | { action: 'take_back'; request: string | null };
