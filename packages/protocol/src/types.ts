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
}

/** Where a pinned local story's refs point now, for the ones that moved since it was told (the others are null). */
export interface LocalMoved {
  base_oid: string | null;
  head_oid: string | null;
}

/** How a local story ships: pushed to the default branch, or through a pull request. */
export type ShipMode = 'push' | 'pr';

/** A built local story: a branch's story before any PR. The board's Open story goes to its local page, Mark reviewed ticks it off. */
export interface InboxLocalStory {
  id: string;
  /** owner/name from its checkout's origin, null when the checkout has none or is gone */
  repo: string | null;
  /** the checkout's folder name, for a label when there is no repo */
  repo_name: string;
  title: string;
  /** the branch it tells the story of (null when detached) */
  branch: string | null;
  /** when the story was last built */
  built_at: string;
  /** when you last opened or reviewed it (null: never) */
  seen_at: string | null;
  reviewed_at: string | null;
  reviewed_by: ReviewedBy | null;
  /** when you approved it for this head (Approve on its page), null when you haven't or a new commit cleared it */
  approved_at: string | null;
  approved_head: string | null;
  /** chapters published with no text yet: while there are any, the story is still being written (absent: none) */
  unwritten?: number;
}

/** A built PR story: the panel opens on the PR's changes page. It is marked reviewed on GitHub or by Viewed. */
export interface InboxStory {
  id: string;
  repo: string;
  number: number;
  title: string;
  /** the PR's head branch, when the story says */
  branch: string | null;
  /** the PR's changes page, where the panel opens */
  url: string;
  /** when the story was last built */
  built_at: string;
  /** when you last opened or reviewed it: the latest of your reads, where you stopped, and a Mark reviewed (null: never) */
  seen_at: string | null;
  reviewed_at: string | null;
  /** why it is reviewed: marked by hand, or marked by itself because you submitted a review after it was built or viewed every file */
  reviewed_by: ReviewedBy | null;
  /** chapters published with no text yet: while there are any, the story is still being written (absent: none) */
  unwritten?: number;
}

/**
 * What marked a story reviewed. `approved` is Approve on a local story's page. The last three are for local stories: its branch has a PR (`pr`), its head is already in
 * the default branch (`delivered`), or nothing touched it for LOCAL_IDLE_DAYS (`idle`).
 */
export type ReviewedBy =
  'manual' | 'review' | 'all viewed' | 'approved' | 'pr' | 'delivered' | 'idle';

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
  files: StoryFile[];
  chapters: Chapter[];
  uncovered_hunks: UncoveredFile[];
  /** the step to open on when nothing is saved */
  start?: number;
  local?: LocalStory;
  /** the page was opened with the story's read-only key (a read-only link): it can't push, so Create pull request says where to open the story */
  read_only?: boolean;
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

// ---------- the bridge's answers

export interface Answer {
  id?: string;
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
  /** the agent that built the story, when this listener relays the story's questions to it */
  agent?: string | null;
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
  /** the subagent that built this story and answers its questions (through a relay), while that can still work */
  agent?: string | null;
  story_prompt?: { prompt: string } | null;
}

/** An idle Claude Code session the panel's Start listening may type into. */
export interface ListenSession {
  id: string;
  title: string;
  status: 'idle' | 'done';
  /** ISO time it went idle, null when unknown */
  since: string | null;
}

/** What Start listening starts: the whole repo's listener, or one for just this story. */
export type ListenTarget = { scope: 'repo'; repo: string } | { scope: 'story' };

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

/** Where a card sits on the agent board (GET /api/board). `error` and `idle` columns show only when a card is in them. */
export type BoardStatus = 'working' | 'waiting' | 'done' | 'error' | 'idle';

/** The latest progress beat an agent posted: step n of `of`. */
export interface BoardBeat {
  n: number;
  of: number;
  step: string;
  note: string;
}

/** A background agent (a subagent) from the ledger file, inside its parent session's card or on a card of its own. */
export interface BoardAgent {
  name: string;
  /** the ledger's own word for where it stands */
  state: 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
  /** `waiting` on your story review (the ledger's `[review]`), not on a question: shown as ready for review */
  review: boolean;
  status: BoardStatus;
  task: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  /** still `running` (or at a gate) long after it started, with no done line: probably never reported back */
  stale: boolean;
  beat: BoardBeat | null;
  /** the automated gate it is at, when it is at one: not on you, the launching session is the next actor */
  gate: BoardGate | null;
  /** the notes file its ledger lines name, when they name one */
  notes: string | null;
  /** a finished agent's card in Waiting leaves the board at this time, unless it does something more first (null on any other agent) */
  clears_at: string | null;
}

/**
 * A gate between "an agent is building" and "ready for your review": a build agent stopped at its plan (`plan`, the
 * ledger's `[plan]`), a reviewer agent running (`review`, a running agent named `review-*`), or the findings being fixed
 * (`fixing`, the ledger's `[fixing]`, with the count its line gives).
 */
export interface BoardGate {
  kind: 'plan' | 'review' | 'fixing';
  findings: number | null;
}

/** The board's columns, in the order the work moves through them: `error` shows only when a card is in it, and idle cards are a lane of their own. */
export type BoardColumn =
  | 'backlog'
  | 'working'
  | 'checks'
  | 'waiting'
  | 'ready'
  | 'ship'
  | 'pr_open'
  | 'back'
  | 'done'
  | 'idle'
  | 'error';

/** What GitHub says about a PR (one GraphQL query, kept a few minutes). */
export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  /** the PR's head branch */
  branch: string | null;
  /** who opened it, and whether that is the signed-in gh user (the board shows only PRs you authored) */
  author: string | null;
  mine: boolean;
  /** GitHub is waiting on you by name (a request to a team you are in is not counted, and the review-requested search skips it too) */
  review_requested: boolean;
  approvals: number;
  /** the base branch's required approving reviews, from its protection rule or rulesets when readable (null: none set, or not visible to you) */
  required: number | null;
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: 'success' | 'failure' | 'pending' | null;
  /** whether the merge button is clickable, and the one thing to say about it: "ready to merge", or what blocks it */
  merge: { ready: boolean; text: string; tone: 'ok' | 'warn' | 'bad' } | null;
  merged_at: string | null;
  /** review threads still open */
  unresolved: number;
  /** the signed-in user's latest review, comment or push on it */
  viewer_at: string | null;
  /**
   * when someone else last asked something of you (people only: no bots, no AI-review comments).
   * On your own PR: a standing changes-requested review, or an open review thread whose last comment is theirs.
   * On someone else's: only an open review thread you are in whose last comment is theirs. New threads you aren't in,
   * and other reviewers' changes requested, are not asked of you.
   */
  others_at: string | null;
}

/** A Claude Code session working on a card, as the board knows it. */
export interface BoardSession {
  id: string;
  title: string;
  cwd: string;
  branch: string | null;
  status: BoardStatus;
  detail: string | null;
  /** when it entered this status, as far as the bridge knows */
  since: string | null;
  /** where the status came from: the terminal's own tab status or Claude Code's registry */
  source: 'iterm' | 'registry';
  /** its iTerm tab is known, so `POST /api/board/focus` can bring it to the front */
  focus: boolean;
  /** how full its context window is (%), when its status line says (board/statusline.ts) */
  context?: number | null;
  /**
   * when it last went quiet (its turn ended), from Claude Code's registry; null while it is busy. The tab's own
   * status can change on a glance, so the board splits Done (context still cached) from Idle by this.
   */
  rested_at?: string | null;
}

/**
 * One card. kind `work` is a branch or PR with the sessions and agents working on it inside; `session` is a session
 * that is not on a branch of its own (the default branch, or no repo); `agent` is a ledger agent whose lane tag put it
 * away from its parent, or whose session is gone.
 */
export interface BoardCard {
  id: string;
  kind: 'work' | 'session' | 'agent' | 'backlog';
  title: string;
  repo: string | null;
  branch: string | null;
  lane: string;
  column: BoardColumn;
  /** the question or status line worth reading at a glance */
  detail: string | null;
  /** when the card entered its column, as far as the bridge knows */
  since: string | null;
  pr: PrInfo | null;
  /** the built story, when there is one (a PR story, else a local story of the branch: no url, its page link is asked for): reviewed, and `unread` when it was built after you last opened or reviewed it */
  story: {
    id: string;
    kind: 'pr' | 'local';
    url: string | null;
    reviewed: boolean;
    unread: boolean;
    /** questions you asked in the story whose answers you haven't read */
    unread_answers: number;
    /** a local story approved for its current head: ready to ship (null: not approved) */
    approved_at: string | null;
    /** a local story approved and ready to ship: Push when its commits go straight to the default branch, else Create pull request (null otherwise) */
    ship: ShipMode | null;
  } | null;
  /**
   * a work card with an open PR whose local checkout has commits origin's branch lacks (a fix made after review), and
   * the local story whose page has the Push box; absent when no local story of the branch is known
   */
  ahead?: { count: number; story: string } | null;
  /** a session is building, rebuilding or fixing for it (a claimed request) */
  building: {
    kind: StoryRequest['kind'] | 'write';
    since: string | null;
    by: string | null;
  } | null;
  sessions: BoardSession[];
  agents: BoardAgent[];
  /** an agent card's parent session, by title */
  parent: string | null;
  /** the session a click on the card brings to the front: its busiest or waiting one, or an agent's parent; null when none is known */
  focus_session: string | null;
  /** that session's iTerm tab is known (the control is disabled otherwise) */
  can_focus: boolean;
  /** a session is listening for this card's story (its own listener), and which session it is */
  listening: BoardListening | null;
  /** Build story, for a card with a session and a branch or PR but no story yet */
  build: BoardBuild | null;
  /** a backlog card's item (the Backlog column: src/board/backlog.ts) */
  backlog?: {
    id: string;
    added_by: string;
    /**
     * work was started on a branch but no card for it exists yet: shown for a day, or while `on` (the voice session or a
     * listening one, which have no cards) is on that branch
     */
    started: {
      branch: string | null;
      at: string | null;
      on: string | null;
      /** what is working it: worktrees on the branch, sessions on it, the ledger agent that started it, whether it merged */
      links?: BoardStartedLinks | null;
    } | null;
    /** the CLI line to paste into a session to start it */
    start_line: string;
    /**
     * an open item a ledger agent names (its task says the id, no `start` needed): what is working it, and whether the
     * agent only tried it (failed, stopped, or finished long ago) so the card is back in Backlog
     */
    agent?: { links: BoardStartedLinks; tried: boolean } | null;
    /** an Assign typed it into this session lately and no start followed (the title is filled from the live view) */
    assigned: {
      session: string;
      session_title: string | null;
      branch: string | null;
      at: string | null;
    } | null;
    /** the idle sessions Assign can offer, and the exact line it would type into each; null once started */
    assign: BoardAssign | null;
  } | null;
  /** backlog items this work card began as: the work's story and column carry on from here */
  from_backlog?: { id: string; title: string }[];
  /** the git worktrees tied to this card (same repo and branch, a session inside, or listed by a started backlog item) */
  worktrees?: BoardWorktree[];
}

/** What git and GitHub say about one worktree (bridge/src/services/worktrees/worktrees.ts). */
export interface BoardWorktree {
  path: string;
  /** the folder's name */
  name: string;
  /** owner/name when the origin is on GitHub */
  repo: string | null;
  /** the lane it belongs to: the repo's name, else the main checkout's folder */
  lane: string;
  /** the repo's main checkout */
  main: string;
  /** null when detached */
  branch: string | null;
  /** the newest commit's time at HEAD */
  last_commit_at: string | null;
  state: 'clean' | 'dirty' | 'unknown';
  modified: number | null;
  untracked: number | null;
  /** commits on no remote; null when unknown */
  unpushed: number | null;
  size_kb: number | null;
  /** the branch's PR as far as GitHub last said */
  pr: { number: number | null; state: 'open' | 'merged' | 'none' | 'unknown' };
  /**
   * merged: the tip is in the default branch (or in the main checkout's branch when that is built on it). superseded: not
   * there, but each commit has a copy (same patch, or same subject and file counts for a branch). pr_merged: its PR
   * merged. pushed: a review checkout, the same as origin's branch with nothing local. new: no commits of its own yet.
   */
  verdict: 'merged' | 'superseded' | 'pr_merged' | 'pushed' | 'unmerged' | 'new' | 'unknown';
  /** live sessions and open agents working in it */
  in_use: string[];
  locked: boolean;
  /** ignored files that cannot be rebuilt (.env, *.local.json, ...): removing the folder deletes them, so the confirm names them */
  ignored: string[];
  /** a removal failed or timed out: it needs a look, and Clean up is not offered again */
  attention: string | null;
  /** the facts are from before this bridge's last start, or a scan has not confirmed them */
  stale: boolean;
  /** Clean up is offered: clean, not in use, and its work is in live or its PR merged */
  removable: boolean;
  /** why it is not removable */
  keep: string[];
  /** the cleanup also deletes the (merged) branch */
  deletes_branch: boolean;
}

/** The worktrees section of the board: the worktrees tied to no card, and the totals over all of them. */
export interface BoardWorktrees {
  /** when the last scan finished (null before the first) */
  at: string | null;
  scanning: boolean;
  total: number;
  removable: number;
  size_kb: number;
  items: BoardWorktree[];
  /** registered worktrees whose folder is gone, with the line that clears them */
  prunable: { path: string; repo: string | null; line: string }[];
}

/** What a started backlog item is being worked by (bridge/src/services/backlog/backlog-links.ts). */
export interface BoardStartedLinks {
  worktrees: { path: string; name: string }[];
  sessions: { id: string; title: string }[];
  /** the ledger agent whose name is who started the item, with its latest beat */
  agent: {
    name: string;
    state: BoardAgent['state'];
    beat: BoardBeat | null;
    outcome: string | null;
    /** when its last ledger line says it ended (null while it is open) */
    ended_at: string | null;
  } | null;
  /** the branch's work has merged */
  merged: boolean;
  /** when it merged, as far as the bridge can tell (a PR's merged time, or a fast-forwarded branch's tip commit); null when unknown */
  merged_at: string | null;
  /** something is linked and the work has not merged: the card stays past the day */
  active: boolean;
  /** the branch an agent that owns an open item works on (found from its worktree), which makes the item started; null otherwise */
  branch?: string | null;
}

/** The voice session, pinned above the columns once voice has started in it today, and kept (collapsed) while paused or ended (Larmor's voice mode: src/board/voice.ts). */
export interface BoardVoice {
  /** the name it answers to, else its title */
  name: string;
  title: string;
  repo: string | null;
  lane: string;
  branch: string | null;
  status: 'listening' | 'speaking' | 'working' | 'paused' | 'away' | 'ended';
  since: string | null;
  /** the agents it started that are running, waiting on you, or ready for your review */
  agents: { running: number; waiting: number; review: number };
  session: string;
  can_focus: boolean;
  /** how full its context window is (%), when its status line says */
  context: number | null;
  /** its last few lines, oldest first: what it said aloud and what you said to it */
  lines: BoardVoiceLine[];
}

/** A session listening for requests, and which session that is. */
export interface BoardListening {
  consumer: string;
  /** the Claude Code session that runs the wait (found from the wait's parent processes), or null when it can't be told */
  session: string | null;
  title: string | null;
  can_focus: boolean;
}

/** One repo in the Listeners lane: who listens for it now, or when it last had a listener. */
export interface BoardListenerRepo {
  repo: string;
  active:
    | (BoardListening & {
        state: 'waiting' | 'handling';
        /** when the repo went from no listener to this one */
        since: string | null;
        /** the last request (question, build or fix) it was handed */
        last_handled_at: string | null;
      })
    | null;
  last_seen: string | null;
  /** idle sessions in the repo's checkout that Start listening can type into (their iTerm tab is known) */
  candidates: { id: string; title: string; status: 'idle' | 'done'; since: string | null }[];
}

/** One standing helper in the footer row (a ledger agent whose task says "standing helper"): never a card. */
export interface BoardHelper {
  name: string;
  /** waiting for a request, or handling one now */
  state: 'waiting' | 'handling';
  /** the session that launched it (the one you reach it through), and that session's title and whether its tab can be focused */
  session: string;
  title: string | null;
  can_focus: boolean;
  /** its latest ledger line */
  last_request_at: string;
}

/** The Assign button on a backlog card: who may be handed the item, and the line that would be typed. */
export interface BoardAssign {
  candidates: {
    id: string;
    title: string;
    status: 'idle' | 'done';
    since: string | null;
    branch: string | null;
    repo: string | null;
    /** a session with no prompt yet (the Blank strip): the best one to hand work to */
    blank: boolean;
  }[];
  /** the line the bridge would type (the same for every candidate; shown in the confirm) */
  prompt: string;
}

/** What Build story would type, and into which session: null session means every session on the card is busy. */
export interface BoardBuild {
  session: string | null;
  prompt: string;
  /** why the button is off: "session busy", or that no tab is known */
  blocked: string | null;
}

/** GET /api/board: lanes (one per repo, or per lane tag), each with its cards. */
export interface BoardData {
  at: string;
  /** which source gave the sessions' status */
  status_source: 'iterm' | 'registry';
  /** something the page should say, such as the terminal's CLI not answering */
  warning: string | null;
  /** the voice session when voice mode is on and board_voice_dir names its folder; it is not on a card */
  voice: BoardVoice | null;
  /**
   * The phone buttons' state, whether or not voice is on: phone mode (Larmor's away mode, from the `away` file) and whether
   * its phone bridge runs. Null unless board_voice_dir and board_larmor_dir are set and the checkout can run voice_ctl.
   */
  phone: { on: boolean; bridge: boolean } | null;
  /**
   * What Start voice may type into: the last voice session (when it is still live) and the live sessions with whether each is
   * at its prompt. Null when the Larmor checkout can't run voice_ctl (the same gate as `phone`).
   */
  voice_start: BoardVoiceStart | null;
  /** the voice session's build agents against board_builder_slots; null when voice is off or its session isn't running */
  builders: BoardBuilders | null;
  /** Larmor's `paused` file exists (board_voice_dir set), voice on or not: a pause left by a session that died needs a Resume */
  voice_paused: boolean;
  /** repos with a listener now, and those that had one in the last week */
  listeners: BoardListenerRepo[];
  /** standing helpers (ledger agents marked "standing helper") whose session is live, for the row under the Listeners */
  helpers: BoardHelper[];
  /** live sessions that have had no prompt yet (new, or just cleared), by lane name: a strip in the Idle lane, not cards */
  blank: { name: string; sessions: BoardBlankSession[] }[];
  lanes: { name: string; cards: BoardCard[] }[];
  /** every git worktree on this Mac (null when the board's worktrees are off) */
  worktrees: BoardWorktrees | null;
  /** the account's usage limits as the freshest status line had them, null when none has rendered lately */
  usage: BoardUsage | null;
}

/** The build agents the voice session has running, against its cap: how many builders are free to assign work to. */
export interface BoardBuilders {
  /** board_builder_slots (default 3) */
  cap: number;
  /** cap less the running builders, never below 0 */
  free: number;
  /** the running builders, oldest first */
  running: { name: string; task: string | null; since: string | null }[];
}

/** The sessions Start voice may type /larmor into. */
export interface BoardVoiceStart {
  last: { id: string; name: string } | null;
  candidates: { id: string; name: string; idle: boolean }[];
}

/** A line of the voice conversation: who said it, what, and when (ms since the epoch). */
export interface BoardVoiceLine {
  who: 'voice' | 'you';
  text: string;
  at: number;
}

/** A usage limit: how much is used (%) and when it resets. */
export interface BoardLimit {
  percent: number;
  resets_at: string | null;
}

/** The account's usage limits, and when a status line last said them. */
export interface BoardUsage {
  five_hour: BoardLimit | null;
  seven_day: BoardLimit | null;
  at: string;
}

/** A session with no prompt yet. */
export interface BoardBlankSession {
  id: string;
  title: string;
  /** its iTerm tab is known, so `POST /api/board/focus` can bring it to the front */
  can_focus: boolean;
  since: string | null;
}

// ---------- the wire shapes the route table (routes.ts) answers with and takes

/** The story panel's width and its questions dock's height, in pixels. */
export interface Layout {
  width?: number;
  chatHeight?: number;
}

/** The page settings in prefs.json (GET and POST /api/prefs). */
export interface Prefs {
  hideWhitespace: boolean;
  diffView: 'unified' | 'split';
  /** the story panel's size, the last one dragged on any page (absent until one is) */
  layout?: Layout;
}

/** A PR, as the tags know it. */
export interface PrRef {
  repo: string;
  number: number;
}

/** A build request's state, as status-many and POST /api/builds say it. */
export interface BuildRequestView {
  id?: string;
  status?: string;
  state?: string;
  mode?: string;
  requested_at?: string;
}

/** One PR's line from POST /api/stories/status-many: its newest story, or its build request's state. */
export interface StoryStatus {
  repo?: string;
  number?: number;
  state?: 'none' | 'queued' | 'building' | 'ready' | string;
  request?: BuildRequestView | null;
  story?: string;
  story_head?: string | null;
  current_head?: string | null;
  stale?: boolean | null;
  newer?: number | null;
  updating?: boolean;
  update_state?: string | null;
  update_mode?: string | null;
  reads?: { read: number; total: number; next?: number | null } | null;
  /** questions asked in the story whose answers they haven't read */
  unread_answers?: number;
}

/** POST /api/stories/status-many's answer. */
export interface StatusMany {
  results: StoryStatus[];
  listening?: Record<string, Listening>;
}

/** GET /api/health. */
export interface Health {
  ok: boolean;
  name: string;
  version: string;
}

/** One story in GET /api/stories (the story's folder is not sent). */
export interface StoryListEntry {
  id: string;
  kind: 'github' | 'local';
  title?: string;
  repo: string | null;
  number: number | null;
  url: string | null;
  head_ref: string | null;
  repo_path: string | null;
  branch: string | null;
  turn: string | null;
  version: string;
}

/** GET /api/stories. */
export interface StoryList {
  stories: StoryListEntry[];
}

/** What many writes answer with when there is nothing more to say. */
export interface Ok {
  ok: true;
}

/** GET /api/board/listen-sessions and GET .../listen: the idle sessions Start listening may type into. */
export interface ListenSessions {
  repo: string | null;
  sessions: ListenSession[];
}

/** What a remove of a worktree from the board says (POST /api/board/worktree/clean). */
export interface WorktreeCleaned {
  ok: true;
  removed: string;
  /** the branch that was deleted, with the sha to restore it from; null when it was kept */
  branch: { name: string; sha: string; restore: string } | null;
  /** why a branch that was to be deleted was kept (git refused) */
  note: string | null;
}

/** A story's Approve (POST .../approve): when it was, and for which commit; null when it isn't approved. */
export interface Approval {
  approved: { at: string; head_oid: string } | null;
}

/** The question's note on a fix-before-push note, as POST .../notes answers: the note with its state. */
export type NoteAnswer = LocalNote & { state?: string };

/** POST .../notes/<id> answers with the changed note, or the id of a deleted one. */
export type NoteUpdateAnswer = NoteAnswer | { deleted: string };

/** GET .../read: what has been read, and what changed after. */
export type ReadsAnswer = ReadInfo;

/** The reviewer's POST .../read answer: the chapter's read mark. */
export interface ReadMark {
  chapter: string;
  [field: string]: unknown;
}

/** POST .../viewed. */
export interface ViewedAnswer {
  path: string;
  viewed: boolean;
}

/** GET .../rebuild and POST .../rebuild. */
export interface RebuildAnswer {
  rebuild: (RebuildView & { id: string }) | null;
}

/** POST .../listen. */
export interface ListenTyped extends Ok {
  typed: string;
}
