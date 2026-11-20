/**
 * Live cards (ADR-27, ADR-29): which cards have a run going. One is live while a run on it is open and not stale. Pure.
 */
import { STALE_MS } from '../../records/agents/events.ts';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import { OPEN } from './claims.ts';

/** The ids of the cards with a run that is open and has shown a sign of life within STALE_MS: the live ones. */
export function liveCardIds(agents: LedgerAgent[], nowMs: number): Set<string> {
  return new Set(
    agents
      .flatMap((agent) => [...(agent.earlier ?? []), agent])
      .filter(
        (run) =>
          !!run.card &&
          OPEN.includes(run.state) &&
          nowMs - (run.lastEvent ?? run.started ?? new Date(nowMs)).getTime() <= STALE_MS,
      )
      .map((run) => run.card as string),
  );
}
