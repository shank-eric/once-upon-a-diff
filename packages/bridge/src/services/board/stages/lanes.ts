import type { BoardCard } from '@once-upon-a-diff/protocol/types';
import path from 'node:path';

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

/** A lane's name for a folder, given the GitHub repo its origin points at (null when unknown): the repo's name, else the folder's own. */
export function laneOf(cwd: string, repo: string | null): string {
  return repo ? repo.split('/')[1] : path.basename(cwd) || cwd;
}
