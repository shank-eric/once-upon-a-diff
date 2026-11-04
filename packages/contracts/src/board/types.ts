/*
 * The agent board's whole answer (GET /api/board) and the parts around the cards: worktrees, voice, listeners,
 * helpers, usage and blank sessions. Types only: nothing here runs.
 */

import type { BoardEditor } from './agent-types.ts';
import type { BoardCard, BoardListening, BoardWorktree } from './card-types.ts';

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
  /** the editors running a repo's queue (each a live session that registered), with their authors: the strip above the columns */
  editors: BoardEditor[];
  /** Larmor's `paused` file exists (board_voice_dir set), voice on or not: a pause left by a session that died needs a Resume */
  voice_paused: boolean;
  /** repos with a listener now, and those that had one in the last week */
  listeners: BoardListenerRepo[];
  /** standing helpers (agents registered `--standing`) whose session is live, for the row under the Listeners */
  helpers: BoardHelper[];
  /** live sessions that have had no prompt yet (new, or just cleared), by lane: a strip in the Idle lane, not cards */
  blank: { key: string; name: string; sessions: BoardBlankSession[] }[];
  /** one per repo, or per lane tag: `key` is the repo's owner/name (else the folder or tag), `name` is the label (the short name, unless two lanes share it) */
  lanes: { key: string; name: string; cards: BoardCard[] }[];
  /** every git worktree on this Mac (null when the board's worktrees are off) */
  worktrees: BoardWorktrees | null;
  /** the account's usage limits as the freshest status line had them, null when none has rendered lately */
  usage: BoardUsage | null;
}

/** The worktrees section of the board: the worktrees tied to no card, and the totals over all of them. */
export interface BoardWorktrees {
  /** when the last scan finished (null before the first) */
  at: string | null;
  scanning: boolean;
  /** every worktree the scan found (the board page filters `items` and `on_cards` by repo, and leaves this one: it only says whether there is a lane to draw) */
  total: number;
  /** how many worktrees are on cards (shown there, not in `items`) */
  on_cards: number;
  /** how many of `items` (the loose ones the lane lists) can be cleaned up; worktrees on cards have their own Clean up on the card */
  removable: number;
  /** the disk the listed `items` take */
  size_kb: number;
  items: BoardWorktree[];
  /** registered worktrees whose folder is gone, with the line that clears them */
  prunable: { path: string; repo: string | null; line: string }[];
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

/** One repo in the Listeners lane: who listens for it now, or when it last had a listener. */
export interface BoardListenerRepo {
  repo: string;
  active:
    | (BoardListening & {
        state: 'waiting' | 'handling';
        /** its session is at work besides waiting (a turn, a request in hand, other tasks); it is still only here, no card */
        busy: boolean;
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

/** One standing helper in the footer row (an agent registered `--standing`): never a card. */
export interface BoardHelper {
  name: string;
  /** waiting for a request, or handling one now */
  state: 'waiting' | 'handling';
  /** the session that launched it (the one you reach it through), and that session's title and whether its tab can be focused */
  session: string;
  title: string | null;
  can_focus: boolean;
  /** its latest event */
  last_request_at: string;
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

/** What a remove of a worktree from the board says (POST /api/board/worktree/clean). */
export interface WorktreeCleaned {
  ok: true;
  removed: string;
  /** the branch that was deleted, with the sha to restore it from; null when it was kept */
  branch: { name: string; sha: string; restore: string } | null;
  /** why a branch that was to be deleted was kept (git refused) */
  note: string | null;
}
