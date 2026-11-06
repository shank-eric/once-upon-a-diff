/**
 * The board's agents: the registered ones (agents.jsonl, events.ts), with the editors read apart. The ledger and
 * progress files the registry mirrors into are logs for people and scripts, never read here.
 */
import path from 'node:path';
import { agentEventsIn } from './events-file.ts';
import { foldAgentEvents } from './events.ts';
import type { LedgerAgent } from './ledger.ts';

/** The registry's file in a bridge home. */
export const agentsFile = (home: string) => path.join(home, 'agents.jsonl');

/** The agents and the editors registered in a bridge home (none when it has no registry file). */
export function readAgents(home: string): { agents: LedgerAgent[]; editors: LedgerAgent[] } {
  const registered = foldAgentEvents(agentEventsIn(agentsFile(home)));
  // an editor is a session running a repo's queue, not an agent: apart from the agents, so none of the stages sees it as one
  return {
    agents: registered.filter((agent) => agent.kind !== 'editor'),
    editors: registered.filter((agent) => agent.kind === 'editor'),
  };
}
