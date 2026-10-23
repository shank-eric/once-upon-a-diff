/*
 * The story and the bridge's answers, as the panel, the extension and the
 * local page take them. The bridge builds them (stories/story-data.ts and its
 * routes), so these types are the contract between the two sides. Types only:
 * nothing here runs.
 */

/** A side of a file's diff: 'L' the old lines, 'R' the new. */
export type Side = 'L' | 'R';

/** Lines on one side of a file's diff. */
export interface LineSpan {
  side: Side;
  start: number;
  end: number;
}

/** A chapter's pointer at some of a file's lines, and what they show. */
export interface ChapterLines extends LineSpan {
  label: string;
}

/** A file a chapter tells. partial: it tells some of it (note says which), and a later chapter more. */
export interface ChapterFile {
  rel: string;
  partial: boolean;
  note: string | null;
  /** this chapter tells all of the file's hunks */
  whole?: boolean;
  /** not listed: the chapter's text points at its lines (the bridge adds these) */
  ref?: boolean;
  lines?: ChapterLines[];
}

/** A comment the story drafted for the reviewer to post (or not). */
export interface DraftComment {
  path: string;
  line: number;
  body: string;
  /** on a removed line */
  side?: 'L';
  /** a rebuild kept it from the earlier telling, and its line is still in the diff */
  carried?: boolean;
  /** a rebuild kept it, but its line isn't in the diff any more */
  unmapped?: boolean;
}

/** A "Since you read it" chapter's commits: from..to. */
export interface SinceRange {
  from: string;
  to: string;
  commits: number | null;
}

export interface Chapter {
  /** what read.json records a read under */
  key: string;
  title: string;
  headline: string;
  scenario: string;
  summary: string;
  narrative: string;
  files: ChapterFile[];
  comments: DraftComment[];
  since?: SinceRange;
  /** the last chapter the bridge adds for files no chapter places */
  auto?: boolean;
}

/** A file of the diff, and its sha256 (GitHub's #diff-<sha> anchors). */
export interface StoryFile {
  rel: string;
  sha: string;
}

/** A changed hunk no chapter points at, as a line reference (`path:40-58`). */
export interface UncoveredHunk extends LineSpan {
  ref: string;
}

export interface UncoveredFile {
  rel: string;
  hunks: UncoveredHunk[];
}

export interface StoryPr {
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** A hunk of a unified diff; lines keep their '+', '-', ' ' or '\\' prefix. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

/** A file of a unified diff (the bridge's util/diff.ts parses them). */
export interface DiffFile {
  rel: string;
  kind: 'modified' | 'created' | 'deleted' | 'renamed';
  stats: DiffStats;
  hunks: DiffHunk[];
  renamed_from?: string;
  binary?: boolean;
  /** a hash of the file's diff text, so a Viewed mark knows when the file changed again */
  hash?: string;
}

/** A file of a local story's diff as the local page draws it, with whether it's Viewed. */
export interface LocalFile {
  rel: string;
  sha: string;
  kind: DiffFile['kind'];
  stats: DiffStats;
  hunks: DiffHunk[];
  renamed_from: string | null;
  binary: boolean;
  hash?: string | null;
  /** Hide whitespace is on and the file's changes are all whitespace */
  whitespace_only: boolean;
  viewed: boolean;
  /** it was Viewed, then changed again */
  viewed_changed: boolean;
}

/** A line note on a local story (notes.json), on its way to being a fix-before-push note. */
export interface LocalNote {
  id: string;
  at: string;
  path: string;
  side: Side;
  line: number;
  body: string;
  done?: boolean;
  /** the drafted comment it came from (Add to fix before push) */
  draft?: string;
  chapter?: number;
  sent?: { request: string; to: string | null; at: string } | null;
  fixed?: { request: string; sha: string; by?: string | null; at: string } | null;
  returned?: { request: string; sha?: string | null; why?: string | null; at: string } | null;
  updated_at?: string;
}

export interface LocalCommit {
  sha: string;
  at: string;
  subject: string;
}

/** What a local story adds: the diff and the bridge's state for it. */
export interface LocalStory {
  hide_whitespace: boolean;
  diff_view: 'unified' | 'split';
  repo: string;
  base: string;
  head: string;
  /** null until the bridge has made the diff */
  base_oid: string | null;
  head_oid: string | null;
  branch: string | null;
  commits: LocalCommit[];
  files: LocalFile[];
  notes: LocalNote[];
}

/** A story as the panel takes it (GET /api/stories/<id>). */
export interface StoryData {
  id: string;
  kind: 'github' | 'local';
  version: string;
  pr: StoryPr;
  title: string;
  overview: string;
  summary: string;
  plan: string;
  files: StoryFile[];
  chapters: Chapter[];
  uncovered_hunks: UncoveredFile[];
  /** the step to open on when nothing is saved */
  start?: number;
  local?: LocalStory;
}

// ---------- the panel's own state and what it reports

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

// ---------- the bridge's answers

export interface Answer {
  at: string;
  text: string;
  by?: string | null;
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
  answers: Answer[];
}

/** A question as the Ask box sends it. */
export interface QuestionAsk {
  text: string;
  step: number;
  chapter: string;
  file: string | null;
}

export type QuestionMark = 'dismiss' | 'restore' | 'collapse' | 'expand' | 'clear';

export interface QuestionMarksAnswer {
  questions: Question[];
  /** the ids a clear dismissed, so Undo can bring back just those */
  cleared?: string[];
}

/** A Claude session waiting on the bridge's inbox. */
export interface ListenerView {
  consumer: string;
  repo?: string | null;
  story?: string | null;
  state?: string;
}

/** Who answers this story's questions. */
export interface Answering {
  consumer: string;
  scope: 'story' | 'repo' | 'all';
}

export interface Listening {
  ok: boolean;
  consumers?: ListenerView[];
  start?: string;
  prompt?: string | null;
  details?: string | null;
  repo?: string | null;
  checkout?: string | null;
  answering?: Answering | null;
  story_prompt?: { prompt: string } | null;
}

/** GET /api/status for a story. */
export interface BridgeStatus {
  bridge: { version: string };
  story?: { ok: boolean; id?: string };
  listening?: Listening;
}

/** Why the bridge couldn't say: it's down, the token is wrong, or it's older than the panel. */
export interface StatusError extends Error {
  code?: 'down' | 'token' | 'old';
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
}

export type FixesAct =
  | { action: 'send' }
  | { action: 'auto'; on: boolean }
  | { action: 'take_back'; request: string | null };

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
  drafts_rev: string;
  fixes_rev: string;
  working_rev: string;
  listening: boolean;
  answering: string | null;
  rebuild: RebuildView | null;
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
