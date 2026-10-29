import type { BoardCard } from '@once-upon-a-diff/shared/types';

/** Lanes: one per repo (or lane tag), the cards grouped by the page into columns. Sorted by name. */
export function groupLanes(cards: BoardCard[]): { name: string; cards: BoardCard[] }[] {
  const lanes = new Map<string, { name: string; cards: BoardCard[] }>();
  for (const card of cards) {
    const key = card.lane.toLowerCase();
    const lane = lanes.get(key) || { name: card.lane, cards: [] };
    lane.cards.push(card);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((first, second) => first.name.localeCompare(second.name));
}
