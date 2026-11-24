/**
 * Where each stored card is shown (ADR-29): the board joins a card to its work, its sessions and its agents by the card's id, not by
 * the name of a branch. A card's home is the work card whose `Work.card` is its id (works.ts `assignCards`), else the session card its
 * session's runs put on its branch (sessions.ts). A card with no home (a listed card nothing stored a PR or work for, or a landed
 * card whose branch a newer card took over) is still found by its repo and branch: the stages that act on it have their own guards
 * for work that is another card's (markLandedWorks reads the story's times).
 */
import { cardOnBranch, cardRiddenOn } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import type { Work } from './types.ts';

export interface Homes {
  /** a stored card's id -> the work or session card it is shown on */
  byCard: Map<string, BoardCard>;
}

/** No homes: every join falls back to the card's repo and branch. */
export const NO_HOMES: Homes = { byCard: new Map() };

/** The homes of this build's cards: the works first (a card with a work and a session is on the work), then the sessions it holds. */
export function cardHomes(
  works: Map<string, Work>,
  cards: BoardCard[],
  joinedSessionCards: Map<string, BoardCard>,
): Homes {
  const byCard = new Map<string, BoardCard>();
  const shown = new Map(cards.map((card) => [card.id, card]));
  for (const work of works.values()) {
    const card = work.card ? shown.get(work.key) : undefined;
    if (work.card && card && !byCard.has(work.card)) {
      byCard.set(work.card, card);
    }
  }
  for (const [id, card] of joinedSessionCards) {
    if (!byCard.has(id)) {
      byCard.set(id, card);
    }
  }
  return { byCard };
}

/**
 * The card on `cards` that stored card `id` rides on: its home, else the work or session card on `place` (the card's repo and
 * branch, or a branch one of its runs registered).
 */
export function homeOf(
  homes: Homes,
  id: string,
  place: Pick<BacklogItem, 'branch' | 'repo'> & Partial<Pick<BacklogItem, 'pr'>>,
  cards: BoardCard[],
): BoardCard | undefined {
  const own = homes.byCard.get(id);
  if (own && cards.includes(own)) {
    return own;
  }
  return cardOnBranch(place, cards);
}

/** `homeOf` for an item that rides on work (`ridesOnWork`): its home, else the card it rides on (`cardRiddenOn`). */
export function ridingHomeOf(
  homes: Homes,
  item: BacklogItem,
  cards: BoardCard[],
): BoardCard | undefined {
  const own = homes.byCard.get(item.id);
  return own && cards.includes(own) ? own : cardRiddenOn(item, cards);
}
