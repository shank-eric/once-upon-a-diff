/*
 * The agents a session launched (the `sid` on each ledger run is the first 8 of its launching session's id), for the session's
 * own card: a session that dispatched agents is never in Research (it is not a finished side-tab thought: its agents are its
 * work), and is Working while one of them runs, wherever that agent sits (on a backlog card, on a card of its own). Pure.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { isRunning } from './agents.ts';

export interface Launched {
  /** the agents it launched that are running now (open and not silent past their limit) */
  running: LedgerAgent[];
}

/**
 * Each session (first 8 of its id) that has registered a run other than its own (`self-XXXXXX` is the session's own work),
 * with those runs that are running now. A session that launched runs, all finished, is in the map with none running.
 */
export function launchedBy(agents: LedgerAgent[], nowMs: number): Map<string, Launched> {
  const found = new Map<string, Launched>();
  for (const agent of agents) {
    if (isSelfName(agent.name)) {
      continue;
    }
    const one = found.get(agent.sid) ?? { running: [] };
    if (isRunning(agent, nowMs)) {
      one.running.push(agent);
    }
    found.set(agent.sid, one);
  }
  return found;
}
