/*
 * The agent board's agents and editors: their status, beats and gates. Types only: nothing here runs.
 */

/** Where a card sits on the agent board (GET /api/board). `error` and `idle` columns show only when a card is in them. */
export type BoardStatus = 'working' | 'waiting' | 'done' | 'error' | 'idle';

/** The latest progress beat an agent posted: step n of `of`. */
export interface BoardBeat {
  n: number;
  of: number;
  step: string;
  note: string;
}

/** A background agent (a subagent) from the agent registry, inside its parent session's card or on a card of its own. */
export interface BoardAgent {
  /** the session id's first 8 characters the agent is registered under (the first half of `key`) */
  sid: string;
  /** the agent's key on the board, `sid:name`: two sessions' agents of one name are two agents */
  key: string;
  name: string;
  /** what the agent says it is, when it registered through `once-upon agent start` (null for an old event whose kind is unknown) */
  kind: 'author' | 'critic' | 'helper' | 'research' | 'editor' | null;
  /** the editor that launched and controls it (an author launched under a live editor's session), else null */
  editor: BoardAgentEditor | null;
  /** its registered state */
  state: 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
  /** `waiting` on your story review (state `review`), not on a question: shown as ready for review */
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
  /** the notes file its events name, when they name one */
  notes: string | null;
  /** a finished agent's card in Waiting leaves the board at this time, unless it does something more first (null on any other agent) */
  clears_at: string | null;
  /**
   * A finished agent's own card, in brief (null on any other agent): what it did (its claimed card's title, else its
   * task; null when that would only repeat the card's title) and why it is done, from its fields, never its outcome text
   */
  summary: { did: string | null; why: string } | null;
}

/** The editor (a session running a repo's build queue) an author belongs to: who to say it is "by", and its tab. */
export interface BoardAgentEditor {
  /** the editor's lane key (its repo's owner/name, else its folder) and the lane's label as the board shows it */
  lane: string;
  /** the lane's label; with two editors on one lane, each adds its session's name, "widgets (clarifi-f9)" */
  label: string;
  /** the session's name (its tab's), else the first 8 of its id: what tells two editors on one lane apart */
  title: string;
  /** the editor's session id, and whether its iTerm tab can be brought forward */
  session: string;
  can_focus: boolean;
}

/** An editor, with the authors (open authors) it controls: a row in the board's editors strip. */
export interface BoardEditor extends BoardAgentEditor {
  /** the name it registered under */
  name: string;
  /** its build slots (`editor start --slots N`) */
  slots: number;
  /** the slots in use: its authors that are working (running, at its plan check, or fixing findings). One at a question or a story review holds none */
  in_use: number;
  since: string | null;
  authors: {
    /** `sid:name`, the agent's key */
    key: string;
    name: string;
    state: BoardAgent['state'];
    /** parked on your story review */
    review: boolean;
    task: string | null;
    beat: BoardBeat | null;
  }[];
}

/**
 * A gate between "an agent is building" and "ready for your review": a build agent stopped at its plan (`plan`), a
 * critic agent running (`review`, a running agent of kind `critic`), or the findings being fixed (`fixing`, with the
 * count its state event gives).
 */
export interface BoardGate {
  kind: 'plan' | 'review' | 'fixing';
  findings: number | null;
}
