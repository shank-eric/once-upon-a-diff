/** What names an agent on the board and which runs are open: the card's runs say who works it (phase.ts), not a claim. */
import { agentId } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from '../../records/agents/ledger.ts';

export const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The key an agent goes by on the board: its launching session and its name (the registry's key). */
export const agentKey = (agent: Pick<LedgerAgent, 'sid' | 'name'>): string =>
  agentId(agent.sid, agent.name);

/** Whether two agent views are the same agent (a card lists each agent once). A view with no key is nobody's twin. */
export const sameAgentView = (first: { key?: string }, second: { key?: string }): boolean =>
  !!first.key && first.key === second.key;
