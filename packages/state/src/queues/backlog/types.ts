/* The backlog's item type. Types only, so backlog.ts and claims.ts both read it without importing each other. */

/** One item as its events fold. */
export interface BacklogItem {
  id: string;
  title: string;
  note: string | null;
  repo: string | null;
  branch: string | null;
  added_by: string;
  added_at: string;
  state: 'open' | 'started' | 'dropped';
  started_at: string | null;
  started_by: string | null;
  dropped_at: string | null;
  /** when a `done` event recorded the work as landed (started items only), and the sha it landed as, when given */
  landed_at: string | null;
  landed_sha: string | null;
  /** the latest session an Assign typed the item into; kept until a start or a drop (shown for ASSIGN_HOURS) */
  assigned: { session: string; branch: string | null; at: string } | null;
  /**
   * the agent that claimed the card (named as it registered, with its launching session's first 8 when given); cleared when it
   * lands (`done`) or by a reopen. `session` is the claimer's full session id (the editor's, so its slots can tell its cards)
   * and `worktree` the checkout the work is in, each null when the claim gave none (an old claim).
   */
  claim: {
    agent: string;
    sid: string | null;
    session: string | null;
    worktree: string | null;
    by: string;
    at: string;
  } | null;
  /** the card lands by hand: a deploy does not mark it done (part of its work lands outside the repo) */
  hold: boolean;
  /** maybe someday: out of the main list into the Someday section (an open card only; cleared when work starts on it) */
  someday: boolean;
  /** an implicit card (ADR-27): derived from the registry's runs, not in backlog.jsonl until `backlog adopt` */
  implicit?: true;
}
