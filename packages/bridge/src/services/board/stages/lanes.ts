import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { laneLabels } from '@once-upon-a-diff/domain/lane-key';
import path from 'node:path';

/**
 * Lanes: one per repo (or lane tag), the cards grouped by the page into columns. A lane's key is its cards' lane (the
 * repo's owner/name); its name is the label, the short name unless two lanes' short names are the same. Sorted by name.
 */
export function groupLanes(
  cards: BoardCard[],
  labels: Map<string, string> = laneLabels(cards.map((card) => card.lane)),
): { key: string; name: string; cards: BoardCard[] }[] {
  const lanes = new Map<string, { key: string; name: string; cards: BoardCard[] }>();
  for (const card of cards) {
    const id = card.lane.toLowerCase();
    const lane = lanes.get(id) || {
      key: card.lane,
      name: labels.get(card.lane) ?? card.lane,
      cards: [],
    };
    lane.cards.push(card);
    lanes.set(id, lane);
  }
  return [...lanes.values()].sort((first, second) => first.name.localeCompare(second.name));
}

/** A lane's key for a folder, given the GitHub repo its origin points at (null when unknown): the repo's owner/name, else the folder's own name. */
export function laneOf(cwd: string, repo: string | null): string {
  return repo ?? (path.basename(cwd) || cwd);
}
