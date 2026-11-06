/**
 * Implicit cards as backlog items (ADR-27): the cards the registry's runs make (records/agents/implicit.ts), shaped like the
 * backlog's own so `backlog list --implicit` and `show` can print them. They are never in the Backlog column and never written to
 * backlog.jsonl until `backlog adopt`. One is live while a run on it is open and not stale. Pure.
 */
import { STALE_MS } from '../../records/agents/events.ts';
import { implicitCards } from '../../records/agents/implicit.ts';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import { OPEN } from './claims.ts';
import type { BacklogItem } from './types.ts';

/** The implicit cards that are not (yet) backlog items, as items marked `implicit`. */
export function implicitItems(
  agents: LedgerAgent[],
  items: Pick<BacklogItem, 'id'>[],
): BacklogItem[] {
  const adopted = new Set(items.map((item) => item.id));
  return implicitCards(agents)
    .filter((card) => !adopted.has(card.id))
    .map((card) => ({
      id: card.id,
      title: card.title,
      note: card.task && card.task !== card.title ? card.task : null,
      repo: card.repo,
      branch: card.branch,
      added_by: card.agent,
      added_at: card.at,
      state: 'open' as const,
      started_at: null,
      started_by: null,
      dropped_at: null,
      landed_at: null,
      landed_sha: null,
      assigned: null,
      // the first run's own session holds the claim: there is no claim row
      claim: {
        agent: card.agent,
        sid: card.sid,
        session: null,
        worktree: null,
        by: card.agent,
        at: card.at,
      },
      hold: false,
      someday: false,
      implicit: true as const,
    }));
}

/** The ids of the implicit cards with a run that is open and has shown a sign of life within STALE_MS: the live ones. */
export function liveImplicitIds(agents: LedgerAgent[], nowMs: number): Set<string> {
  return new Set(
    implicitCards(agents)
      .filter((card) =>
        card.runs.some(
          (run) =>
            OPEN.includes(run.state) &&
            nowMs - (run.lastEvent ?? run.started ?? new Date(nowMs)).getTime() <= STALE_MS,
        ),
      )
      .map((card) => card.id),
  );
}
