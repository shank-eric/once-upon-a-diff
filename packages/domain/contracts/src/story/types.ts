/*
 * The story and its diff: chapters, files and hunks, a local story (commits, notes), the pull request and push views,
 * and what a story page is sent (StoryData). Types only: nothing here runs.
 */

import type { Side } from '@once-upon-a-diff/terms/line-refs';
import type { StoryParts } from '@once-upon-a-diff/terms/parts';

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

/**
 * A place in a story's diff that its text can link to: a chapter's `refs` entry. The narrative links to it as
 * `[text](ref:<id>)`. `id` is the author's, unique in the chapter that holds it. With `start` it is a line range on
 * `side` (R, the new lines, by default); without, it is the file.
 */
export interface ChapterRef {
  id: string;
  path: string;
  /** no lines: the link goes to the file */
  side?: Side;
  start?: number;
  end?: number;
  label?: string;
  /** made by the bridge from the text of a story told before refs: it links, but is not a pointer a chapter chose to make (hunk coverage, a file's line list) */
  text?: boolean;
}

/** A file a chapter tells. partial: it tells some of it (note says which), and a later chapter more. */
export interface ChapterFile {
  rel: string;
  partial: boolean;
  note: string | null;
  /** this chapter tells all of the file's hunks */
  whole?: boolean;
  /** an older story only: not listed, its text pointed at this file's lines (the bridge adds these when it reads one) */
  ref?: boolean;
  /** derived by the bridge from the chapter's `refs` on this file: the lines this chapter shows of it */
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
  /** what read.json records a read under; the bridge assigns it when a chapter is published without one */
  key: string;
  title: string;
  headline: string;
  scenario: string;
  summary: string;
  narrative: string;
  files: ChapterFile[];
  /** the places the narrative links to (`[text](ref:<id>)`), each on a file the chapter lists */
  refs: ChapterRef[];
  comments: DraftComment[];
  since?: SinceRange;
  /** the last chapter the bridge adds for files no chapter places */
  auto?: boolean;
  /** derived by the bridge, never in chapters.json: a published chapter with no narrative yet, which is still being written */
  unwritten?: boolean;
  /** derived by the bridge: the chapter was first published without its text, so a Viewed tick made meanwhile is not a read */
  skeleton?: boolean;
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
  /** Approve was clicked for this head and nothing has moved it since; null otherwise */
  approved: { at: string; head_oid: string } | null;
  /** a story pinned to a branch (not HEAD) whose branch or base has moved since it was told: the current commit of each ref that did, else null; null when nothing moved */
  moved: LocalMoved | null;
  /** what ships it: `push` for commits on the repo's default branch (or a repo set to push), else `pr` (Create pull request) */
  ship: ShipMode;
  /**
   * a storyless review (a by-folder story: no story was told, the diff by folder). It has no Approve: seeing the diff and
   * clicking Push or Create pull request is the approval
   */
  storyless: boolean;
}

/** Where a pinned local story's refs point now, for the ones that moved since it was told (the others are null). */
export interface LocalMoved {
  base_oid: string | null;
  head_oid: string | null;
}

/** How a local story ships: pushed to the default branch, or through a pull request. */
export type ShipMode = 'push' | 'pr';

/** The PR title and body a session handed over for a local story's branch (`once-upon pr-draft`). */
export interface PrDraft {
  title: string;
  body: string;
  /** the branch the PR goes into, when the session named one */
  base: string | null;
  at: string;
}

/**
 * Where a local story's branch stands on GitHub, for the page's Create pull request button (GET .../pr):
 * missing (not pushed yet), same (GitHub has this commit), ahead (new commits to push), diverged (GitHub's copy
 * has commits this checkout doesn't, so a push would be refused) or unreachable (ls-remote failed).
 */
export type PrRemoteState = 'missing' | 'same' | 'ahead' | 'diverged' | 'unreachable';

export interface PrView {
  /** owner/name, from the checkout's origin; null when origin isn't on GitHub */
  repo: string | null;
  /** the story's branch; null on a detached HEAD */
  branch: string | null;
  /** the branch the PR goes into: the draft's, else the story's base when it names one, else origin's default */
  base: string;
  /** the branch's commit now */
  head_sha: string | null;
  remote: { state: PrRemoteState; sha: string | null; error?: string };
  /** what a push sends, newest first */
  to_push: LocalCommit[];
  draft: PrDraft | null;
  /** the branch's open PR, when gh found one */
  pull: { number: number; url: string } | null;
}

/** POST .../pr {action: 'push'}: git's own lines, and the view after it. */
export interface PrPushAnswer {
  output: string;
  view: PrView;
}

/**
 * Where origin's default branch stands against the approved commit, for the page's Push box (GET .../push): same (it has
 * the commit), ahead (the commit is new there: a fast-forward), behind (it already has the commit and more), diverged
 * (it has commits this checkout doesn't), missing (no such branch on origin) or unreachable (the fetch failed).
 */
export type PushRemoteState = 'same' | 'ahead' | 'behind' | 'diverged' | 'missing' | 'unreachable';

export interface PushView {
  /** owner/name, from the checkout's origin; null when origin isn't on GitHub */
  repo: string | null;
  /** origin's default branch, where the push goes; null when the checkout doesn't say */
  branch: string | null;
  /** the approved commit: a push sends up to it and no further; null when the story isn't approved */
  approved_sha: string | null;
  approved_at: string | null;
  /** commits on the local branch after the approved one, which stay local */
  later: number;
  remote: { state: PushRemoteState; sha: string | null; error?: string };
  /** what a push sends, newest first */
  to_push: LocalCommit[];
  /** whether GitHub protects the branch or requires pull requests (unknown when gh couldn't say, which also stops a push) */
  protection: { state: 'open' | 'protected' | 'unknown'; reason?: string };
  /** why a push can't go ahead; null when it can */
  blocker: string | null;
  /** the blocker is one a pull request goes around, so the box offers Create pull request */
  pr_instead: boolean;
}

/** POST .../push {action: 'push', head_sha}: git's own lines, and the view after it. */
export interface PushAnswer {
  output: string;
  view: PushView;
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
  /** the places the overview, summary and plan link to (`[text](ref:<id>)`), on any file of the story */
  overview_refs?: ChapterRef[];
  files: StoryFile[];
  chapters: Chapter[];
  /** the repo's parts and the ones each chapter touches (domain/parts.ts), when the repo has a parts file; the panel draws them as a strip (absent: no strip) */
  parts?: StoryParts;
  uncovered_hunks: UncoveredFile[];
  /** the step to open on when nothing is saved */
  start?: number;
  local?: LocalStory;
  /** the page was opened with the story's read-only key (a read-only link): it can't push, so Create pull request says where to open the story */
  read_only?: boolean;
}

/** A story's Approve (POST .../approve): when it was, and for which commit; null when it isn't approved. */
export interface Approval {
  approved: { at: string; head_oid: string } | null;
}

/** The question's note on a fix-before-push note, as POST .../notes answers: the note with its state. */
export type NoteAnswer = LocalNote & { state?: string };

/** POST .../notes/<id> answers with the changed note, or the id of a deleted one. */
export type NoteUpdateAnswer = NoteAnswer | { deleted: string };

/** POST .../viewed. */
export interface ViewedAnswer {
  path: string;
  viewed: boolean;
}
