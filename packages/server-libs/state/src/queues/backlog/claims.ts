/** What names an agent on the board, which runs are open and which cards are listed: the card's runs say who works it (phase.ts), not a claim. */
import { agentId } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import type { BacklogItem } from './types.ts';

export const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The key an agent goes by on the board: its launching session and its name (the registry's key). */
export const agentKey = (agent: Pick<LedgerAgent, 'sid' | 'name'>): string =>
  agentId(agent.sid, agent.name);

/** Whether two agent views are the same agent (a card lists each agent once). A view with no key is nobody's twin. */
export const sameAgentView = (first: { key?: string }, second: { key?: string }): boolean =>
  !!first.key && first.key === second.key;

/**
 * Whether the Backlog column, the lists and the checks that decide what a card IS see it: a card someone added (or an agent's,
 * once adopted). The cards the first fact about some work made (`source` agent, session, pr, story) are stored and found by id,
 * and shown by nothing until the board reads them (ADR-29).
 */
export const isListed = (item: Pick<BacklogItem, 'source'>): boolean =>
  (item.source ?? 'backlog') === 'backlog';
