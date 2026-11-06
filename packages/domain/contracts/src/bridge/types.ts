/*
 * The bridge's own answers: its status and listeners, errors, the inbox, page settings, build requests, story
 * statuses and the small acknowledgements. Types only: nothing here runs.
 */

import type { ErrorCode } from '@once-upon-a-diff/terms/error-code';

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
  /** a storyless review: the by-folder fallback, no story told (absent: a told story) */
  storyless?: true;
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

/** What every non-2xx answer from the bridge is: its message (for people) and its code (for programs). */
export interface ErrorBody {
  error: string;
  code: ErrorCode;
}

/** Why the bridge couldn't say: it's down, the token is wrong, or it's older than the panel. */
export interface StatusError extends Error {
  code?: 'down' | 'token' | 'old';
}

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
  /** deprecated: the build's mode, sent for an older extension (read `update_kind`) */
  update_mode?: string | null;
  /** what the pending update is: a plain update to the latest commit, or a rebuild of the story */
  update_kind?: 'update' | 'rebuild' | null;
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

/** POST .../listen. */
export interface ListenTyped extends Ok {
  typed: string;
}
