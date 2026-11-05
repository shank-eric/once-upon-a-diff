/*
 * The story panel's own state and what it reports: its saved UI, where the reader is, the pulse, freshness, rebuild
 * and read state, and the working marks. Types only: nothing here runs.
 */

/** The panel's state, which the host saves (opts.onState) and passes back (opts.initial). */
export interface PanelUi {
  /** the step: 0 is the Overview, 1..N the chapters */
  n: number;
  /** Show all files */
  all: boolean;
  collapsed: boolean;
  width: number;
  filesOpen: boolean;
  showPosted: boolean;
  showDismissed: boolean;
  /** the questions dock at the bottom is open, and its height */
  chatOpen: boolean;
  chatHeight: number;
}

/** Where the reviewer is: the step and the file at the top of the screen. */
export interface PanelPosition {
  step: number;
  chapter: string;
  file: string | null;
}

/** A chapter the reviewer read, for the bridge's read.json. */
export interface ReadEvent {
  chapter: string;
  step: number;
  title: string;
  reason: 'time' | 'viewed' | 'inferred';
  seconds: number | null;
  head_sha: string | null;
}

/** Lines a session says it's changing, as [start, end] pairs. */
export type LineRanges = [number, number][];

/** A Claude session's "being changed" mark. */
export interface WorkingMark {
  consumer: string;
  files: { path: string; ranges?: LineRanges }[];
  started_at: string;
  at: string;
}

export interface RebuildView {
  id?: string;
  mode: 'rebuild' | 'rebuild_from';
  from_step?: number | null;
  state: 'queued' | 'building' | 'done' | 'failed';
  requested_at?: string;
  done_at?: string | null;
  note?: string | null;
  claimed_by?: string | null;
}

/** A rebuild as the panel asks for it. */
export interface RebuildAsk {
  mode: 'rebuild' | 'rebuild_from';
  from_step?: number;
  guidance?: string;
  requested_at: string;
}

/** The pulse: one cheap call a tick, saying which parts changed. */
export interface Pulse {
  version: string;
  questions_rev: string;
  /** questions whose answer you haven't read */
  unread_answers?: number;
  drafts_rev: string;
  fixes_rev: string;
  working_rev: string;
  listening: boolean;
  answering: string | null;
  /** the subagent that built the story and answers its questions through a relay, while its binding can be used */
  agent?: string | null;
  rebuild: RebuildView | null;
  /** a build, update, rebuild or fix request for the story that a session has yet to finish, or null */
  request: StoryRequest | null;
}

/** A request a Claude session is to do for a story: queued until a listener takes it, building once one has. */
export interface StoryRequest {
  kind: 'build' | 'update' | 'rebuild' | 'fix';
  state: 'queued' | 'building';
  requested_at: string;
  /** who took it, once it is building */
  claimed_by: string | null;
  claimed_at: string | null;
}

/** What a story's last update brought in. */
export interface FreshUpdate {
  from: string;
  to: string;
  newer?: number | null;
  retold?: boolean;
  /** when the update was done */
  at?: string | null;
  changed_files?: string[];
  chapters_touched?: number[];
}

/** Is the story up to date with the PR's latest commit? */
export interface Freshness {
  state: 'current' | 'stale' | 'unknown' | 'n/a';
  story_head?: string | null;
  current_head?: string | null;
  newer?: number | null;
  rewritten?: boolean;
  changed_files?: string[];
  chapters_touched?: number[];
  updated?: FreshUpdate | null;
  error?: string | null;
}

/** A chapter that changed after they read it. files null: the bridge didn't say which. */
export interface ReadChange {
  step: number;
  files: string[] | null;
  since?: string | null;
}

/** GET /read: the chapters they've read, and what changed in them since. */
export interface ReadInfo {
  reads: Record<string, unknown>;
  since?: unknown;
  changed?: ReadChange[];
  stale_comments?: { step: number; index: number }[];
}

/** The reviewer's POST .../read answer: the chapter's read mark. */
export interface ReadMark {
  chapter: string;
  [field: string]: unknown;
}

/** GET .../read: what has been read, and what changed after. */
export type ReadsAnswer = ReadInfo;

/** GET .../rebuild and POST .../rebuild. */
export interface RebuildAnswer {
  rebuild: (RebuildView & { id: string }) | null;
}
