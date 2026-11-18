/*
 * When a run whose subagent has stopped is ended for it, and how: the one rule behind the SubagentStop hook (registry.ts
 * `autoFinish`, which writes the end) and the board's reading of a run whose transcript has gone quiet (board/stages/dead-runs.ts,
 * which only shows it). Pure.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import { isCritic, type LedgerAgent } from './ledger.ts';

/** The states a sweep or an auto-end closes: a run that owes beats. One parked on a person (waiting, review, plan) is never closed. */
export const SWEPT_STATES: LedgerAgent['state'][] = ['running', 'fixing'];

/**
 * Whether a run that stopped is ended for it: only a run still `running` or `fixing`, never a standing helper, an editor or a
 * parent session's own run (`--self`), which idle between requests by design.
 */
export const canAutoEnd = (
  agent: Pick<LedgerAgent, 'state' | 'name'> & Partial<Pick<LedgerAgent, 'standing' | 'kind'>>,
): boolean =>
  SWEPT_STATES.includes(agent.state) &&
  !agent.standing &&
  agent.kind !== 'editor' &&
  !isSelfName(agent.name);

/**
 * How a stopped run ends. An author's or a critic's run (work that owes a commit or findings, and a run with no kind) is `failed`,
 * so its card shows a failure and not a Done it never reported; any other kind (a helper, a researcher, a storyteller) is `done`.
 */
export function endOfStopped(agent: Partial<Pick<LedgerAgent, 'kind'>>): {
  state: 'failed' | 'done';
  outcome: string;
} {
  // a run with no kind counts as work too (same rule as isWorkRun in queues/backlog/phase.ts)
  const owesWork = !agent.kind || agent.kind === 'author' || isCritic(agent);
  return owesWork
    ? { state: 'failed', outcome: 'stopped without agent finish' }
    : { state: 'done', outcome: 'auto-finished' };
}
