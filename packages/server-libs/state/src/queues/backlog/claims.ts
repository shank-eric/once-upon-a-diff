/**
 * Who has claimed a backlog card. A claim is explicit (`once-upon backlog claim ID --agent NAME`, an event in
 * backlog.jsonl): the agent, or the session that launched it, says "this card is mine". Nothing is guessed from an agent's
 * task text, its name or its worktree folder. A card has one claim and an agent may hold several. The claim finds no run
 * (ADR-25, the flip): a run that names its card (`agent start --card`) is that card's, and phase.ts reads the card from its
 * runs. What a claim still does is say who took the card, show it as "pending" for CLAIM_GRACE_HOURS (the launcher claims
 * before the agent's first line lands) and let an author start on the card at all.
 * Pure: the board gathers the facts.
 */
import { agentId } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import type { BacklogItem } from './types.ts';

/** A claim whose agent has no registered event yet counts this long (the launcher claims before the agent's first event lands). */
export const CLAIM_GRACE_HOURS = 2;

export const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The key an agent goes by on the board: its launching session and its name (the registry's key). */
export const agentKey = (agent: Pick<LedgerAgent, 'sid' | 'name'>): string =>
  agentId(agent.sid, agent.name);

/** Whether two agent views are the same agent (a card lists each agent once). A view with no key is nobody's twin. */
export const sameAgentView = (first: { key?: string }, second: { key?: string }): boolean =>
  !!first.key && first.key === second.key;

/**
 * The claim still in force: its run is in the registry, or it is under CLAIM_GRACE_HOURS old (the agent's first event has not
 * landed yet). Null when the item has none, is dropped or landed, or the claim is old and its run never turned up.
 */
export function liveClaim(
  item: BacklogItem,
  agent: unknown,
  nowMs: number,
): { claim: NonNullable<BacklogItem['claim']>; pending: boolean } | null {
  const claim = item.claim;
  if (!claim || item.state === 'dropped' || item.landed_at) {
    return null;
  }
  if (agent) {
    return { claim, pending: false };
  }
  const since = Date.parse(claim.at);
  return !Number.isNaN(since) && nowMs - since <= CLAIM_GRACE_HOURS * 3600 * 1000
    ? { claim, pending: true }
    : null;
}
