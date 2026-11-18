/* The backlog's item type. Types only, so backlog.ts and claims.ts both read it without importing each other. */

/** What made a card (ADR-29): `backlog` is a card someone added; the others are cards the first fact about some work made. Only `backlog` cards are listed. */
export type CardSource = 'backlog' | 'agent' | 'session' | 'pr' | 'story';

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
  /** what made the card; an old row with no `source` is `backlog` */
  source: CardSource;
  /** the checkout the work is in (a path), from a `link` or the claim's; null until one is learned */
  worktree: string | null;
  /** the PR's number, once GitHub answered for the card's branch (repo is the card's); null until then */
  pr: number | null;
  /** the id of the story built for the card's work; stories keep no card id */
  story: string | null;
  /** the full id of the Claude session that made a `session` or `agent` card */
  session: string | null;
  started_at: string | null;
  started_by: string | null;
  dropped_at: string | null;
  /** when a `done` event recorded the work as landed (started items only), and the sha it landed as, when given */
  landed_at: string | null;
  landed_sha: string | null;
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
  /** the card's critic is skipped by hand (Eric's call on the board's Waiting): a built card with no passing critic is Ready, not Waiting */
  critic_skipped?: boolean;
  /** maybe someday: out of the main list into the Someday section (an open card only; cleared when work starts on it) */
  someday: boolean;
  /** an implicit card (ADR-27): derived from the registry's runs, not in backlog.jsonl until `backlog adopt` */
  implicit?: true;
}
