/** The board's columns and groups, and the pure sort of the board's data into what the page shows. */
import type { BoardCard, BoardColumn, BoardData } from '/assets/types.ts';

/**
 * The columns in the order the work moves through them, from Backlog (kept for later) to Done, in two groups: what is still on this Mac and what is on GitHub.
 * Research and Error appear only when a card is in them; idle cards are a lane along the bottom.
 */
export const COLUMNS: {
  id: BoardColumn;
  label: string;
  group: 'local' | 'github';
  always: boolean;
}[] = [
  { id: 'backlog', label: 'Backlog', group: 'local', always: true },
  { id: 'working', label: 'Working', group: 'local', always: true },
  { id: 'checks', label: 'Agent checks', group: 'local', always: false },
  { id: 'waiting', label: 'Waiting', group: 'local', always: true },
  { id: 'research', label: 'Research', group: 'local', always: false },
  { id: 'ready', label: 'Ready for your review', group: 'local', always: true },
  { id: 'ship', label: 'Ready to ship', group: 'local', always: false },
  { id: 'error', label: 'Error', group: 'local', always: false },
  { id: 'pr_open', label: 'PR open', group: 'github', always: true },
  { id: 'back', label: 'Back to you', group: 'github', always: true },
  { id: 'done', label: 'Done', group: 'github', always: true },
];

export const GROUPS = [
  { id: 'local', label: 'On this Mac' },
  { id: 'github', label: 'On GitHub' },
] as const;

/**
 * How long a session keeps its context cached after its turn ends: the prompt cache's lifetime, an hour on these
 * sessions. Past it, picking the session up re-reads its whole context.
 */
const WARM_MS = 60 * 60 * 1000;

/** Whether a resting card's newest session went quiet within WARM_MS (by Claude Code's registry, not the tab's status). */
export function isWarm(card: BoardCard, now: number): boolean {
  const rested = card.sessions
    .map((session) => (session.rested_at ? Date.parse(session.rested_at) : NaN))
    .filter((time) => !Number.isNaN(time));
  return rested.length > 0 && now - Math.max(...rested) < WARM_MS;
}

/** A Backlog card in the Someday section: out of the Backlog column's lanes and count (the section lists it). */
export const isSomeday = (card: BoardCard) => card.column === 'backlog' && !!card.backlog?.someday;

/** Someone else's PR with nothing on you and no session of yours on it: the ball is in its author's court. */
export const isOnAuthor = (card: BoardCard) =>
  card.column === 'pr_open' && !!card.pr && !card.pr.mine && !card.sessions.length;

/**
 * Sorts the board's data into what the page shows: the cards that are not hidden, the columns that have a reason to appear
 * (the always-on ones and those with a card), each column's lanes of cards, and the Done and Idle lanes. Pure, so it is
 * the one place the page's counts come from.
 */
export function arrange(data: BoardData, hideOnAuthor: boolean, now: number) {
  const shown = (card: BoardCard) => !(hideOnAuthor && isOnAuthor(card));
  const inColumns = (card: BoardCard) => shown(card) && !isSomeday(card);
  const all = data.lanes.flatMap((lane) => lane.cards);
  const cards = all.filter(shown);
  const columns = COLUMNS.filter(
    (column) => column.always || cards.some((card) => card.column === column.id),
  );
  const count = (id: BoardColumn) =>
    cards.filter((card) => card.column === id && !isSomeday(card)).length;
  const someday = data.lanes
    .map((lane) => ({ name: lane.name, cards: lane.cards.filter(isSomeday) }))
    .filter((group) => group.cards.length);
  const idle = data.lanes
    .flatMap((lane) =>
      lane.cards
        .filter((card) => card.column === 'idle')
        .map((card) => ({ lane: lane.name, card })),
    )
    .sort(
      (first, second) =>
        first.lane.localeCompare(second.lane) ||
        String(first.card.since).localeCompare(String(second.card.since)),
    );
  return {
    cards,
    columns,
    count,
    someday,
    somedayCount: someday.reduce((sum, group) => sum + group.cards.length, 0),
    onAuthorCount: all.filter(isOnAuthor).length,
    // a column lists its cards by lane, the lane's label right above its cards (so the two are never far apart)
    lanesOf: (column: BoardColumn) =>
      data.lanes
        .map((lane) => ({
          name: lane.name,
          cards: lane.cards
            .filter((card) => card.column === column && inColumns(card))
            // Backlog keeps the order you gave it; the others go by how long they have been there
            .sort((first, second) =>
              column === 'backlog' ? 0 : String(first.since).localeCompare(String(second.since)),
            ),
        }))
        .filter((group) => group.cards.length),
    // Done: finished lately, its context still cached, so picking it up is cheap; Idle: it would re-read everything
    done: idle.filter((item) => isWarm(item.card, now)),
    cold: idle.filter((item) => !isWarm(item.card, now)),
    blankCount: data.blank.reduce((sum, group) => sum + group.sessions.length, 0),
  };
}

export type Layout = ReturnType<typeof arrange>;
