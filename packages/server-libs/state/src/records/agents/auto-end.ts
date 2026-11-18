/*
 * When a run whose subagent has stopped is ended for it, and how: the one rule behind the SubagentStop hook (registry.ts
 * `autoFinish`, which writes the end) and the board's reading of a run whose transcript has gone quiet (board/stages/dead-runs.ts,
 * which only shows it). Pure.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import { isCritic, lastActivity, type LedgerAgent } from './ledger.ts';

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

/**
 * A run's last sign of life when its transcript is known: the later of the transcript's last write (`wrote`, the adapter's
 * answer in ms) and its last ledger event. null when there is no answer (an entry that is not a positive number) or the run is
 * not one an auto-end judges (`canAutoEnd`): no verdict, so the 24-hour rule stands.
 */
export function quietSign(
  agent: Pick<LedgerAgent, 'state' | 'name'> &
    Partial<Pick<LedgerAgent, 'standing' | 'kind'>> &
    Parameters<typeof lastActivity>[0],
  wrote: number | undefined,
): number | null {
  if (!wrote || !Number.isFinite(wrote) || wrote <= 0 || !canAutoEnd(agent)) {
    return null;
  }
  return Math.max(wrote, lastActivity(agent)?.getTime() ?? 0);
}
