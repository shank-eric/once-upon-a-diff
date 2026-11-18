/**
 * What a board build learned about the work it saw (ADR-29, branch B): the facts the card keeper (card-keeper.ts) writes onto stored
 * cards. The board builds these and writes nothing; the bridge hands them to the keeper. Types only.
 */

/** One piece of work the build saw, with every fact it found for it. `pr` is set only when GitHub answered for that number. */
export interface LearnedCard {
  /** a PR, branch or story's work, or a session on a branch of its own */
  kind: 'work' | 'session';
  /** what made the card: `pr` when `pr` is known, else `story` when it has one, else `session` */
  source: 'pr' | 'story' | 'session';
  title: string;
  repo: string;
  /** a feature branch (never main, never none): a card with no branch to join by is not learned */
  branch: string;
  worktree: string | null;
  pr: number | null;
  /** the PR number the work carries when GitHub has not answered for it (`pr` is then null), so the keeper still knows whose work it is */
  asked?: number | null;
  story: string | null;
  /** the full id of the first live session on the work */
  session: string | null;
}

/** A PR GitHub said is merged or closed (or a story's merge): its number never names new work again. */
export interface EndedPr {
  repo: string;
  number: number;
}

export interface LearnedCards {
  cards: LearnedCard[];
  /** the PRs seen merged or closed this build, so the keeper does not put new work on a card of theirs */
  ended: EndedPr[];
  /** the PRs GitHub said are open this build: a stored PR card is joined by branch only by work that has no PR of its own while its PR is one of these */
  open: EndedPr[];
}

export const NOTHING_LEARNED: LearnedCards = { cards: [], ended: [], open: [] };
