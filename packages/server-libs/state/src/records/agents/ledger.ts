/**
 * The background agents the board shows inside their parent session's card: the agents registered through
 * `once-upon agent start|state|beat|finish`, folded from <home>/agents.jsonl (events.ts, registry.ts). Nothing here is
 * parsed from text. The ledger and progress files (the settings board_ledger_file and board_progress_file) are logs the
 * CLI writes for people and scripts (registry.ts mirrors each event there); the board never reads them.
 *
 * States: running; waiting (finished, but its result needs a decision; `review` set when it is parked on your story
 * review instead of a question); plan and fixing (the launching session, not you, is the next actor: a plan to check,
 * a critic's findings being fixed); done, failed and stopped. A running critic (kind `critic`) or storyteller (kind `storyteller`) is a gate too.
 *
 * A finished agent with no card to sit in is a card of its own, in the column finishedColumn (board/agent-home.ts) picks
 * from its fields, for board_finished_wait_minutes (30; an author in Waiting stays board_done_hours, 1 hour) after its
 * latest event (an author whose commit is on a branch that is not merged waits in Ready for your review, Ready to ship or PR open
 * with no timer instead: see pendingColumn). The board's Finish on that card finishes a still-waiting agent through the registry, and otherwise just
 * records the click (adapters/stores/finished-agents.ts).
 */
import type { BoardBeat, BoardGate } from '@once-upon-a-diff/contracts/types';
import type { AgentKind, AgentResult, AgentRole } from './agent-types.ts';

/** One agent as its registered events tell it. */
export interface LedgerAgent {
  sid: string;
  name: string;
  state: 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
  /** waiting on your story review (state `review`), not on a question */
  review?: boolean;
  /** the model and effort the run started with, joined ("sonnet, high"): what its `[running]` line shows */
  model: string | null;
  /** the model alone ("sonnet"), null when the run named none, whatever its effort */
  modelName: string | null;
  task: string | null;
  started: Date | null;
  ended: Date | null;
  outcome: string | null;
  /** the notes file its latest event names, when one does */
  notes?: string | null;
  /**
   * the runs before this one, oldest first: a `start` of the same sid and name (a SendMessage follow-up, a fix round)
   * starts a new run, and the earlier one is kept here as it stood
   */
  earlier?: LedgerAgent[];
  run?: string | null;
  /** the launching session's full id, when the agent was registered from a Claude session */
  session?: string | null;
  kind?: AgentKind | null;
  /** registered `--standing`: held out of the cards, shown in the Helpers row */
  standing?: boolean;
  repo?: string | null;
  branch?: string | null;
  /** the registered branch's tip when the run started (null when the branch did not exist yet), to tell at finish whether it moved */
  tip?: string | null;
  pr?: number | null;
  cwd?: string | null;
  card?: string | null;
  /** the name of the earlier run of the same session this run retries (`--replaces`): that run, if it failed, is not news once this one is done */
  replaces?: string | null;
  /** what the run said it does on its card (`--role`; only a fixer is told from an author by it), null on an old row */
  role?: AgentRole | null;
  /** an editor's build slots (kind `editor`) */
  slots?: number | null;
  result?: AgentResult | null;
  /** an author finished done with no commit and its worktree had changes (recorded once, at the finish): it waits in Ready for your review */
  uncommitted?: true;
  findings?: number | null;
  /** when a failed run was acknowledged (`agent ack`): the board stops counting it as failed. Set only when it was */
  acked?: Date;
  /** this run's end was written by the SubagentStop hook, not by the agent: the agent's own finish replaces it */
  autoFinished?: true;
  /** this run's latest progress beat */
  beat?: BoardBeat | null;
  /** its latest event of any kind, a beat included: the sign of life staleness is measured from */
  lastEvent?: Date | null;
}

/** An acknowledged failed run (`agent ack`). */
export const isAcked = (agent: Pick<LedgerAgent, 'state' | 'acked'>): boolean =>
  agent.state === 'failed' && !!agent.acked;

/** The state the board shows for a run: an acknowledged failed run reads as stopped, so it no longer holds its card in Waiting or shows the failed mark. */
export const shownState = (agent: Pick<LedgerAgent, 'state' | 'acked'>): LedgerAgent['state'] =>
  isAcked(agent) ? 'stopped' : agent.state;

/** The gate an agent is at, or null: its plan to check, findings being fixed, or a critic or a storyteller running. The one place for the rule. */
export function gateOf(
  agent: Pick<LedgerAgent, 'state'> & Partial<Pick<LedgerAgent, 'kind' | 'findings'>>,
): BoardGate | null {
  if (agent.state === 'plan') {
    return { kind: 'plan', findings: null };
  }
  if (agent.state === 'fixing') {
    return { kind: 'fixing', findings: agent.findings ?? null };
  }
  if (agent.state === 'running' && isCritic(agent)) {
    return { kind: 'review', findings: null };
  }
  return agent.state === 'running' && isStoryteller(agent)
    ? { kind: 'story', findings: null }
    : null;
}

/** A critic: its registered kind says so. */
export const isCritic = (agent: Partial<Pick<LedgerAgent, 'kind'>>): boolean =>
  agent.kind === 'critic';

/** A storyteller: its registered kind says so. */
export const isStoryteller = (agent: Partial<Pick<LedgerAgent, 'kind'>>): boolean =>
  agent.kind === 'storyteller';

/** When an agent last did anything: its latest event, a beat included, else its end or start. Null when it has none. */
export function lastActivity(
  agent: Pick<LedgerAgent, 'ended' | 'started'> & Partial<Pick<LedgerAgent, 'lastEvent'>>,
): Date | null {
  return agent.lastEvent ?? agent.ended ?? agent.started ?? null;
}

/** "3:40 PM ET, 11/2": a time as the ledger's writers write it, always in Eastern time and always labelled, so it reads the same whatever zone the reader is set to. */
export function ledgerTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
    hour12: true,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()} ET, ${get('month')}/${get('day')}`;
}
