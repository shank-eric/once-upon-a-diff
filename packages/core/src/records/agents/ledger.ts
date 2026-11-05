/**
 * The background agents the board shows inside their parent session's card: the agents registered through
 * `once-upon agent start|state|beat|finish`, folded from <home>/agents.jsonl (events.ts, registry.ts). Nothing here is
 * parsed from text. The ledger and progress files (the settings board_ledger_file and board_progress_file) are logs the
 * CLI writes for people and scripts (registry.ts mirrors each event there); the board never reads them.
 *
 * States: running; waiting (finished, but its result needs a decision; `review` set when it is parked on your story
 * review instead of a question); plan and fixing (the launching session, not you, is the next actor: a plan to check,
 * a critic's findings being fixed); done, failed and stopped. A running critic (kind `critic`) is a gate too.
 *
 * A finished agent with no card to sit in is a card of its own, in the column finishedColumn (board/agent-home.ts) picks
 * from its fields, for board_finished_wait_minutes (30; an author in Waiting stays board_done_hours, 1 hour) after its
 * latest event (an author whose commit is on a branch with no PR that is not merged waits in Ready for your review with
 * no timer instead). The board's Finish on that card finishes a still-waiting agent through the registry, and otherwise just
 * records the click (adapters/stores/finished-agents.ts).
 */
import type { BoardBeat, BoardGate } from '@once-upon-a-diff/contracts/types';
import type { AgentKind, AgentResult } from './agent-types.ts';

/** One agent as its registered events tell it. */
export interface LedgerAgent {
  sid: string;
  name: string;
  state: 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
  /** waiting on your story review (state `review`), not on a question */
  review?: boolean;
  lane: string | null;
  model: string | null;
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
  /** an editor's build slots (kind `editor`) */
  slots?: number | null;
  result?: AgentResult | null;
  findings?: number | null;
  /** this run's latest progress beat */
  beat?: BoardBeat | null;
  /** its latest event of any kind, a beat included: the sign of life staleness is measured from */
  lastEvent?: Date | null;
}

/** The gate an agent is at, or null: its plan to check, findings being fixed, or a critic running. The one place for the rule. */
export function gateOf(
  agent: Pick<LedgerAgent, 'state'> & Partial<Pick<LedgerAgent, 'kind' | 'findings'>>,
): BoardGate | null {
  if (agent.state === 'plan') {
    return { kind: 'plan', findings: null };
  }
  if (agent.state === 'fixing') {
    return { kind: 'fixing', findings: agent.findings ?? null };
  }
  return agent.state === 'running' && isCritic(agent) ? { kind: 'review', findings: null } : null;
}

/** A critic: its registered kind says so. */
export const isCritic = (agent: Partial<Pick<LedgerAgent, 'kind'>>): boolean =>
  agent.kind === 'critic';

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
