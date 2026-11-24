/*
 * What `once-upon compact` keeps of backlog.jsonl. The log only grows, and ADR-29 makes the stored cards of agents, sessions, PRs
 * and stories (`source` other than `backlog`) its bulk, so a card nobody can still be on goes, with every event it has (found by the
 * event's `id`). It plans from the lines and returns lines, never new ones: the fold and the format are untouched, and the cards
 * that stay fold as they did, in the same order (a listed card's moves name listed cards or edges, and a card another card's `move`
 * names stays).
 *
 * A card goes when ALL hold:
 *   - its final `source` is not `backlog` (a card someone added, or adopted, stays whole);
 *   - no run in the retained agents.jsonl names it (`named`), and no `move` names it as `before`;
 *   - it is closed (dropped or landed) at or before the cutoff, or it is an `agent` or `session` card with no PR and no story
 *     whose latest event of any kind (the latest `at` of its lines, not the last line: a backfilled `add` is older than the lines
 *     around it) is before the cutoff, and (for a `session` card) its session is not live: the keeper writes nothing onto a card
 *     that has every fact, so a session on one branch for weeks has an old card. A card with a PR or a story goes only by closing:
 *     an open long-lived PR's card never does.
 * A line that is not an event, and a line of an id no `add` made, stays as it is.
 *
 * Pure: the caller reads the runs, the clock, and writes (adapters' `replaceLog`).
 */
import { readBacklogEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { foldBacklogEvents, isListed } from './backlog.ts';

type BacklogEvent = NonNullable<ReturnType<typeof readBacklogEvent>>;

const parse = (line: string): BacklogEvent | null => {
  try {
    return readBacklogEvent(JSON.parse(line)) ?? null;
  } catch {
    return null;
  }
};

/** The lines to keep, in the file's order. `cutoffMs` is the time before which a card is idle or closed; `named` tells a card some retained run names. */
export function compactBacklogLines(lines: string[], options: CompactOptions): string[] {
  return planBacklogLines(lines, options).kept;
}

interface CompactOptions {
  cutoffMs: number;
  named: (id: string) => boolean;
  /** whether a session (its full id) is still running; with none, no session is */
  live?: (session: string) => boolean;
}

/** The lines to keep, and the lines of the cards that go (for the archive), each in the file's order. */
export function planBacklogLines(
  lines: string[],
  { cutoffMs, named, live = () => false }: CompactOptions,
): { kept: string[]; archived: string[] } {
  const events = lines.map(parse);
  const items = foldBacklogEvents(events.flatMap((event) => event ?? []));
  const latest = new Map<string, number>(); // a card's latest event time
  const target = new Set<string>(); // the cards a move names
  for (const event of events) {
    if (!event) {
      continue;
    }
    const when = Date.parse(event.at ?? '');
    if (Number.isFinite(when)) {
      latest.set(event.id, Math.max(latest.get(event.id) ?? -Infinity, when));
    }
    if (event.op === 'move' && event.before) {
      target.add(event.before);
    }
  }
  const goes = new Set<string>();
  for (const item of items) {
    if (isListed(item) || named(item.id) || target.has(item.id)) {
      continue;
    }
    const closedAt = Date.parse(item.dropped_at ?? item.landed_at ?? '');
    const closed = item.state === 'dropped' || !!item.landed_at;
    if (closed && Number.isFinite(closedAt) && closedAt <= cutoffMs) {
      goes.add(item.id);
      continue;
    }
    const idle = (latest.get(item.id) ?? Infinity) < cutoffMs;
    const running = item.source === 'session' && !!item.session && live(item.session);
    if (
      (item.source === 'agent' || item.source === 'session') &&
      !item.pr &&
      !item.story &&
      idle &&
      !running
    ) {
      goes.add(item.id);
    }
  }
  const archived = (index: number) => {
    const event = events[index];
    return !!event && goes.has(event.id);
  };
  return {
    kept: lines.filter((_, index) => !archived(index)),
    archived: lines.filter((_, index) => archived(index)),
  };
}
