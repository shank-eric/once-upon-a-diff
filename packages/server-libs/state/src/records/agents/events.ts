/**
 * Registered agents: the events `once-upon agent start|state|beat|finish` append to <home>/agents.jsonl, and how they
 * fold into the board's agents (LedgerAgent). Nothing here is parsed from prose: a kind, a state, a time and a result
 * are fields. The format (AgentEvent) is the contracts package's: contracts/src/files/schemas.ts.
 * ledgerLine and beatLine write each event as a log line for people and scripts (registry.ts).
 *
 *   {op:'start',  v, id, sid8, session, name, at, by, run, kind, role, standing, task, model, effort, repo, branch, tip, pr, cwd, card, replaces, notes}
 *   {op:'state',  ..., state: running|waiting|review|plan|fixing, outcome, findings, notes}
 *   {op:'beat',   ..., n, of, step, note}                 also the heartbeat: it counts as the agent's last sign of life
 *   {op:'branch', ..., run, branch}                       the open run's branch moved (a rename)
 *   {op:'card',   ..., run, card}                         a run, open or over, moved to another card (`backlog drop --into`)
 *   {op:'ack',    ..., run}                               a failed run, open or over, was acknowledged (`agent ack`): the board stops counting it as failed
 *   {op:'finish', ..., state: done|failed|stopped, outcome, result: {commit, pr, branch, card}, findings, notes}
 *
 * A finish by `auto-finish` (the SubagentStop hook) is the run's end until the agent's own finish: that one replaces it (autoFinished).
 * `id` is `<sid8>:<name>`: the launching session's first 8 characters and the agent's name (agentKey). A `start` begins a
 * run; the other events belong to the latest run of the id. A `start` after a run began a new run, and the earlier
 * run is kept in `earlier` as it stood. Fields the fold does not know are ignored, so later cards can add them.
 * Pure: the store (registry.ts) reads and writes.
 */
import { jsonLines } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { ledgerTime, type LedgerAgent } from './ledger.ts';
import { AGENT_KINDS, type AgentKind } from './agent-types.ts';
import {
  KIND_ALIASES,
  readAgentEvent,
  type AgentEvent,
} from '@once-upon-a-diff/contracts/files/schemas';

export { KIND_ALIASES, type AgentEvent };

/** The canonical kind for a stored or typed value (an alias reads as its new name), or null when it is none. */
export function canonicalKind(raw: unknown): AgentKind | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const kind = Object.hasOwn(KIND_ALIASES, raw)
    ? KIND_ALIASES[raw as keyof typeof KIND_ALIASES]
    : raw;
  return (AGENT_KINDS as readonly string[]).includes(kind) ? (kind as AgentKind) : null;
}

/** A run with no event this long is taken to be dead: it holds no build slot, and an unnamed beat does not land on it. */
export const STALE_MS = 24 * 3600 * 1000;

/**
 * A work run (running or fixing) whose own subagent transcript, and every event of its own, has been silent this long is dead
 * (board/stages/dead-runs.ts). Only a run whose transcript is found is judged by it: with none, STALE_MS stands.
 */
export const QUIET_MS = 30 * 60 * 1000;

/** A storyteller with no event this long is dead (the sweep never closes it): it is not working and holds no gate. */
export const STORYTELLER_STALE_MS = 3600 * 1000;

/** How long a run may stay silent before the board reads it as dead: an hour for a storyteller, STALE_MS for the rest. */
export const staleAfterMs = (agent: { kind?: string | null }): number =>
  agent.kind === 'storyteller' ? STORYTELLER_STALE_MS : STALE_MS;

/** The events in a file's text, in order. Lines that aren't events are skipped. */
export function parseAgentEvents(text: string): AgentEvent[] {
  return jsonLines(text).flatMap((value) => readAgentEvent(value) ?? []);
}

const isOpen = (agent: Pick<LedgerAgent, 'state'>) =>
  agent.state === 'running' ||
  agent.state === 'waiting' ||
  agent.state === 'plan' ||
  agent.state === 'fixing';

/** Whether a run is still going (running, at a gate, or waiting on a question or a story review). */
export const runIsOpen = isOpen;

/**
 * Whether a run takes an event for it: the run is open (or its auto-finish is being replaced), and the event names no
 * other run (one with no run, or either side unnamed, is for this one).
 */
export function takesEvent(
  agent: Pick<LedgerAgent, 'state' | 'run'>,
  eventRun: string | null | undefined,
  replaces: boolean,
): boolean {
  const namesOtherRun = !!eventRun && !!agent.run && eventRun !== agent.run;
  return (isOpen(agent) || replaces) && !namesOtherRun;
}

/** Whether a finish's named card moves with its run when the run moves off `from`: only a finish that named that card does. */
export const movesWith = (named: string | null | undefined, from: string | null | undefined) =>
  !!named && named === from;

type Agents = Map<string, LedgerAgent>;

/** A run left open when the next one starts is over. */
function closedBefore(agent: LedgerAgent, when: Date): LedgerAgent {
  const before: LedgerAgent = { ...agent, earlier: undefined };
  if (isOpen(before)) {
    before.state = 'stopped';
    before.review = false;
    before.ended = when;
  }
  return before;
}

function startedAgent(event: AgentEvent, when: Date, earlier: LedgerAgent[]): LedgerAgent {
  const model = [event.model, event.effort].filter(Boolean).join(', ');
  return {
    sid: event.sid8,
    name: event.name,
    state: 'running',
    review: false,
    model: model || null,
    modelName: event.model || null,
    task: event.task ?? null,
    started: when,
    ended: null,
    outcome: null,
    notes: event.notes ?? null,
    run: event.run ?? null,
    session: event.session ?? null,
    kind: canonicalKind(event.kind),
    role: event.role ?? null,
    standing: event.standing === true,
    repo: event.repo ?? null,
    branch: event.branch ?? null,
    tip: event.tip ?? null,
    pr: event.pr ?? null,
    cwd: event.cwd ?? null,
    card: event.card ?? null,
    replaces: event.replaces ?? null,
    slots: event.slots ?? null,
    result: null,
    findings: null,
    beat: null,
    lastEvent: when,
    ...(earlier.length ? { earlier } : {}),
  };
}

function applyStart(agents: Agents, event: AgentEvent, when: Date): void {
  const agent = agents.get(event.id);
  const earlier = agent ? [...(agent.earlier ?? [])] : [];
  if (agent) {
    earlier.push(closedBefore(agent, when));
  }
  agents.set(event.id, startedAgent(event, when, earlier));
}

/** The run an event for a run, open or over, points at: the latest, or one of the earlier ones. */
function runNamedBy(agent: LedgerAgent | undefined, event: AgentEvent): LedgerAgent | undefined {
  return agent && (!event.run || event.run === agent.run)
    ? agent
    : agent?.earlier?.find((one) => one.run === event.run);
}

/** A run moved to another card, whatever state it is in: the move is not a sign of life, and changes nothing else. */
function applyCard(agent: LedgerAgent | undefined, event: AgentEvent): void {
  const run = runNamedBy(agent, event);
  if (run && event.run && event.card) {
    // a finish that named the old card now names the new one (it is replaced, never changed: a restart copies a run's `result` by reference)
    if (movesWith(run.result?.card, run.card)) {
      run.result = { ...run.result, card: event.card };
    }
    run.card = event.card;
  }
}

/** A run, open or over, acknowledged: a mark and nothing else, no sign of life. One for a run still open is a mistake and changes nothing. */
function applyAck(agent: LedgerAgent | undefined, event: AgentEvent, when: Date): void {
  const run = runNamedBy(agent, event);
  if (run && event.run && !isOpen(run)) {
    run.acked = when;
  }
}

function applyBeat(agent: LedgerAgent, event: AgentEvent): void {
  agent.beat = {
    n: event.n ?? 0,
    of: event.of ?? 0,
    step: event.step ?? '',
    note: event.note ?? '',
  };
}

/** A rename moves the run's branch and nothing else: the run goes on, and `result` is what a finish recorded. */
function applyBranch(agent: LedgerAgent, event: AgentEvent): void {
  agent.branch = event.branch ?? agent.branch;
}

function applyState(agent: LedgerAgent, event: AgentEvent, when: Date): void {
  // running again starts a new round: the last count is not this one's
  agent.findings = event.state === 'running' ? null : (event.findings ?? agent.findings ?? null);
  const state = event.state === 'review' ? 'waiting' : (event.state as LedgerAgent['state']);
  if (agent.autoFinished) {
    // the stop was not the end after all: the hook's end and what it recorded are gone
    delete agent.autoFinished;
    delete agent.acked;
    delete agent.uncommitted;
    agent.result = null;
  }
  agent.state = state;
  agent.review = event.state === 'review';
  // running again (a plan checked, a fix begun) clears what the gate said
  agent.ended = state === 'running' ? null : when;
  agent.outcome = state === 'running' ? null : (event.outcome ?? null);
}

function applyFinish(agent: LedgerAgent, event: AgentEvent, when: Date): void {
  agent.findings = event.findings ?? agent.findings ?? null;
  agent.state = event.state as LedgerAgent['state'];
  agent.review = false;
  agent.ended = when;
  agent.outcome = event.outcome ?? null;
  agent.result = event.result ?? null;
  if (event.uncommitted) {
    agent.uncommitted = true;
  } else {
    delete agent.uncommitted;
  }
  if (event.by === 'auto-finish') {
    agent.autoFinished = true;
  } else {
    delete agent.autoFinished;
  }
}

/** The events that change the latest run's fields but not its notes. */
const RUN_EVENTS: Record<string, (agent: LedgerAgent, event: AgentEvent) => void> = {
  beat: applyBeat,
  branch: applyBranch,
};

/** A state event, or a finish (any other op): both take the event's notes first. */
function applyEnding(agent: LedgerAgent, event: AgentEvent, when: Date): void {
  agent.notes = event.notes || agent.notes;
  if (event.op === 'state') {
    applyState(agent, event, when);
  } else {
    applyFinish(agent, event, when);
  }
}

function applyRunEvent(agent: LedgerAgent, event: AgentEvent, when: Date): void {
  // a rename is not the agent working, so it is no sign of life
  if (event.op !== 'branch') {
    agent.lastEvent = when;
  }
  const apply = RUN_EVENTS[event.op];
  if (apply) {
    apply(agent, event);
  } else {
    applyEnding(agent, event, when);
  }
}

/** Whether the agent's own finish or state replaces the hook's auto-finish. */
function replacesAutoFinish(agent: LedgerAgent, event: AgentEvent): boolean {
  // the agent's own finish after the hook's replaces it; any other event for a run that is over is ignored
  // (a later `state` does too: a planner or resumed agent parks as waiting, review or plan after the stop)
  return (
    (event.op === 'finish' || event.op === 'state') &&
    !!agent.autoFinished &&
    event.by !== 'auto-finish'
  );
}

/** The agents the events tell, one per id with its latest run, runs before it in `earlier`. */
export function foldAgentEvents(events: AgentEvent[]): LedgerAgent[] {
  const agents: Agents = new Map();
  for (const event of events) {
    const when = new Date(event.at);
    const agent = agents.get(event.id);
    if (event.op === 'start') {
      applyStart(agents, event, when);
    } else if (event.op === 'card') {
      applyCard(agent, event);
    } else if (event.op === 'ack') {
      applyAck(agent, event, when);
    } else if (agent && takesEvent(agent, event.run, replacesAutoFinish(agent, event))) {
      // an event names its run: one for a run that is not the latest (a restarted agent's old beats and finish) is not this run's
      applyRunEvent(agent, event, when);
    }
  }
  return [...agents.values()];
}

/** Text safe inside a ledger line: its parts are split on " — ". */
const flat = (text: string | null | undefined) => (text ?? '').replace(/\s+—\s+/g, ' - ').trim();

/**
 * The ledger line for what an event did to its run, so the ledger file stays a readable log. Scripts outside this repo
 * (the subagent status line, the iTerm status hook) read these lines with their own patterns: keep the format.
 * `agent` is the run after the event.
 */
export function ledgerLine(event: AgentEvent, agent: LedgerAgent): string {
  const head = `sid:${event.sid8} ${event.name}`;
  const time = ledgerTime(new Date(event.at));
  const tail = (outcome: string | null | undefined) =>
    [outcome ? flat(outcome) : '', agent.notes ?? ''].filter(Boolean).join(' — ');
  if (event.op === 'start' || (event.op === 'state' && event.state === 'running')) {
    const model = agent.model ? ` (${agent.model})` : '';
    const began = ledgerTime(agent.started ?? new Date(event.at));
    return `- [running] ${head}${model} — ${flat(agent.task)} — started ${began}`;
  }
  const state = event.state === 'review' ? 'review' : (event.state as string);
  let outcome = event.outcome;
  if (state === 'fixing' && event.findings != null && !/\d+\s+findings?/i.test(outcome ?? '')) {
    outcome = `${event.findings} findings${outcome ? `: ${outcome}` : ''}`;
  }
  const rest = tail(outcome);
  return `- [${state}] ${head} — ${time}${rest ? ` — ${rest}` : ''}`;
}

/** The progress line for a beat (`once-upon beat` and `agent beat` write this one form). */
export function beatLine(
  event: Pick<AgentEvent, 'at' | 'name' | 'n' | 'of' | 'step' | 'note'>,
): string {
  const time = ledgerTime(new Date(event.at)).replace(/ ET,.*$/, '');
  const note = event.note ? `: ${event.note}` : '';
  return `- ${time} ${event.name} ${event.n}/${event.of} ${event.step}${note}`;
}
