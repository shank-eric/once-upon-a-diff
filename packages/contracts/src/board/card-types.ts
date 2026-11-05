/*
 * The agent board's cards (a backlog or PR card with its session, build, review, links and worktrees) and the columns
 * they sit in. Types only: nothing here runs.
 */

import type { StoryRequest } from '../panel/types.ts';
import type { ShipMode } from '../story/types.ts';
import type { BoardAgent, BoardBeat, BoardStatus } from './agent-types.ts';

/** The board's columns, in the order the work moves through them: `research` and `error` show only when a card is in them, and idle cards are a lane of their own. */
export type BoardColumn =
  | 'backlog'
  | 'working'
  | 'checks'
  | 'waiting'
  | 'research'
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
 * that is not on a branch of its own (the default branch, or no repo); `agent` is a registered agent whose lane tag put it
 * away from its parent, or whose session is gone.
 */
export interface BoardCard {
  id: string;
  kind: 'work' | 'session' | 'agent' | 'backlog';
  title: string;
  repo: string | null;
  branch: string | null;
  /** the lane key: the repo's owner/name, else the folder's name (or a lane tag, or "General") */
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
    /** a storyless review (a by-folder local story): Build story still tells one */
    storyless?: true;
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
  /**
   * The branch's checkout, for Review (a storyless review of its diff: POST /api/board/review) and for the path Build story
   * names: a finished author's commit waiting on your review, or a work card's branch with no PR. Absent otherwise
   */
  review?: BoardReview | null;
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
      /** what is working it: worktrees on the branch, sessions on it, the registered agent that started it, whether it merged */
      links?: BoardStartedLinks | null;
    } | null;
    /** maybe someday: set only when true (an open, unworked card the Someday section lists, out of the main Backlog) */
    someday?: true;
    /** the CLI line to paste into a session to start it */
    start_line: string;
    /**
     * an open item whose claimed agent is in the registry (no `start` needed): what is working it, and whether the agent
     * only tried it (failed, stopped, or finished long ago) so the card is back in Backlog
     */
    agent?: { links: BoardStartedLinks; tried: boolean } | null;
    /**
     * who claimed it (`once-upon backlog claim ID --agent NAME`), while the claim is in force. `pending`: the agent has
     * no registered event yet, so the card says "claimed, not started" until it does (or the claim is old and drops)
     */
    claim?: { agent: string; at: string | null; pending: boolean } | null;
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

/** What git and GitHub say about one worktree (core/src/records/worktrees/worktrees.ts). */
export interface BoardWorktree {
  path: string;
  /** the folder's name */
  name: string;
  /** owner/name when the origin is on GitHub */
  repo: string | null;
  /** the lane it belongs to, as a lane key: the repo's owner/name, else the main checkout's folder */
  lane: string;
  /** the lane's label as the board shows it, set on the Worktrees lane's items: the short name, unless another lane shares it */
  lane_label?: string;
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
   * there, but each commit has a copy (the same patch). pr_merged: its PR
   * merged. pushed: a review checkout, the same as origin's branch with nothing local. new: no commits of its own yet.
   */
  verdict: 'merged' | 'superseded' | 'pr_merged' | 'pushed' | 'unmerged' | 'new' | 'unknown';
  /** live sessions and open registered agents whose folder is in it: by id, `label` is only for showing */
  in_use: { kind: 'session' | 'agent'; id: string; label: string }[];
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

/** What a started backlog item is being worked by (core/src/queues/backlog/backlog-links.ts). */
export interface BoardStartedLinks {
  worktrees: { path: string; name: string }[];
  sessions: { id: string; title: string }[];
  /** the registered agent that holds the item's claim (`once-upon backlog claim`), with its latest beat */
  agent: {
    name: string;
    state: BoardAgent['state'];
    beat: BoardBeat | null;
    outcome: string | null;
    /** when its finish event says it ended (null while it is open) */
    ended_at: string | null;
  } | null;
  /** the branch's work has merged */
  merged: boolean;
  /** when it merged, as far as the bridge can tell (a PR's merged time, or a fast-forwarded branch's tip commit); null when unknown */
  merged_at: string | null;
  /** something is linked and the work has not merged: the card stays past the day */
  active: boolean;
}

/** A session listening for requests, and which session that is. */
export interface BoardListening {
  consumer: string;
  /** the Claude Code session that runs the wait (found from the wait's parent processes), or null when it can't be told */
  session: string | null;
  title: string | null;
  can_focus: boolean;
}

/** The Assign button on a backlog card: the message it sends the voice session (the same for every click). */
export interface BoardAssign {
  prompt: string;
}

/** A branch to review without a story: its name and the checkout it is in. */
export interface BoardReview {
  branch: string;
  path: string;
}

/** What Build story would type, and into which session: null session means every session on the card is busy. */
export interface BoardBuild {
  session: string | null;
  prompt: string;
  /** why the button is off: "session busy", or that no tab is known */
  blocked: string | null;
}
