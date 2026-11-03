/**
 * Registered agents: the events `once-upon agent start|state|beat|finish` append to <home>/agents.jsonl, and how they
 * fold into the board's agents (the same LedgerAgent the ledger's lines give, with the fields the lines can't carry).
 * Nothing here is parsed from prose: a kind, a state, a time and a result are fields.
 *
 *   {op:'start',  v, id, sid8, session, name, at, by, run, kind, task, model, effort, repo, branch, tip, pr, cwd, card, lane, notes}
 *   {op:'state',  ..., state: running|waiting|review|plan|fixing, outcome, findings, notes}
 *   {op:'beat',   ..., n, of, step, note}                 also the heartbeat: it counts as the agent's last sign of life
 *   {op:'finish', ..., state: done|failed|stopped, outcome, result: {commit, pr, branch, card}, findings, notes}
 *
 * `id` is `<sid8>:<name>`: the launching session's first 8 characters and the agent's name (agentKey). A `start` begins a
 * run; the other events belong to the latest run of the id. A `start` after a run began a new run, and the earlier
 * run is kept in `earlier` as it stood. Fields the fold does not know are ignored, so later cards can add them.
 * Pure: the store (registry.ts) reads and writes.
 */
import { ledgerTime, type LedgerAgent } from './ledger.ts';
import type { BoardBeat } from '@once-upon-a-diff/protocol/types';

export const AGENT_KINDS = ['builder', 'reviewer', 'helper', 'research'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** A run with no event this long is taken to be dead: it holds no build slot, and an unnamed beat does not land on it. */
export const STALE_MS = 24 * 3600 * 1000;

export const OPEN_STATES = ['running', 'waiting', 'review', 'plan', 'fixing'] as const;
export const END_STATES = ['done', 'failed', 'stopped'] as const;

/** What a finished run made: each part optional. */
export interface AgentResult {
  commit?: string;
  pr?: number;
  branch?: string;
  card?: string;
}

/** One event line as stored. */
export interface AgentEvent {
  op: 'start' | 'state' | 'beat' | 'finish';
  v?: number;
  id: string;
  sid8: string;
  session?: string | null;
  name: string;
  at: string;
  by?: string;
  run?: string;
  kind?: AgentKind;
  task?: string;
  model?: string | null;
  effort?: string | null;
  repo?: string | null;
  branch?: string | null;
  /** start only: the registered branch's tip then, or null */
  tip?: string | null;
  pr?: number | null;
  cwd?: string | null;
  card?: string | null;
  lane?: string | null;
  notes?: string | null;
  state?: string;
  outcome?: string | null;
  findings?: number | null;
  result?: AgentResult | null;
  n?: number;
  of?: number;
  step?: string;
  note?: string;
}

/** The events in a file's text, in order. Lines that aren't events are skipped. */
export function parseAgentEvents(text: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as AgentEvent;
      if (
        event &&
        ['start', 'state', 'beat', 'finish'].includes(event.op) &&
        typeof event.id === 'string' &&
        typeof event.sid8 === 'string' &&
        typeof event.name === 'string' &&
        !Number.isNaN(Date.parse(event.at))
      ) {
        events.push(event);
      }
    } catch {
      // a half-written or hand-edited line: skipped
    }
  }
  return events;
}

const isOpen = (agent: Pick<LedgerAgent, 'state'>) =>
  agent.state === 'running' ||
  agent.state === 'waiting' ||
  agent.state === 'plan' ||
  agent.state === 'fixing';

/** Whether a run is still going (running, at a gate, or waiting on a question or a story review). */
export const runIsOpen = isOpen;

/** The agents the events tell, one per id with its latest run, runs before it in `earlier`. */
export function foldAgentEvents(events: AgentEvent[]): LedgerAgent[] {
  const agents = new Map<string, LedgerAgent>();
  for (const event of events) {
    const when = new Date(event.at);
    const agent = agents.get(event.id);
    if (event.op === 'start') {
      const earlier = agent ? [...(agent.earlier ?? [])] : [];
      if (agent) {
        // a run left open when the next one starts is over
        const before: LedgerAgent = { ...agent, earlier: undefined };
        if (isOpen(before)) {
          before.state = 'stopped';
          before.review = false;
          before.ended = when;
        }
        earlier.push(before);
      }
      const model = [event.model, event.effort].filter(Boolean).join(', ');
      agents.set(event.id, {
        sid: event.sid8,
        name: event.name,
        state: 'running',
        review: false,
        lane: event.lane ?? null,
        model: model || null,
        task: event.task ?? null,
        started: when,
        ended: null,
        outcome: null,
        notes: event.notes ?? null,
        source: 'events',
        run: event.run ?? null,
        session: event.session ?? null,
        kind: event.kind ?? null,
        repo: event.repo ?? null,
        branch: event.branch ?? null,
        tip: event.tip ?? null,
        pr: event.pr ?? null,
        cwd: event.cwd ?? null,
        card: event.card ?? null,
        result: null,
        findings: null,
        beat: null,
        lastEvent: when,
        ...(earlier.length ? { earlier } : {}),
      });
      continue;
    }
    // an event names its run: one for a run that is not the latest (a restarted agent's old beats and finish) is not this run's
    if (!agent || !isOpen(agent) || (event.run && agent.run && event.run !== agent.run)) {
      continue;
    }
    agent.lastEvent = when;
    if (event.op === 'beat') {
      agent.beat = {
        n: event.n ?? 0,
        of: event.of ?? 0,
        step: event.step ?? '',
        note: event.note ?? '',
      };
      continue;
    }
    agent.notes = event.notes || agent.notes;
    if (event.op === 'state') {
      // running again starts a new round: the last count is not this one's
      agent.findings =
        event.state === 'running' ? null : (event.findings ?? agent.findings ?? null);
      const state = event.state === 'review' ? 'waiting' : (event.state as LedgerAgent['state']);
      agent.state = state;
      agent.review = event.state === 'review';
      // running again (a plan checked, a fix begun) clears what the gate said
      agent.ended = state === 'running' ? null : when;
      agent.outcome = state === 'running' ? null : (event.outcome ?? null);
      continue;
    }
    agent.findings = event.findings ?? agent.findings ?? null;
    agent.state = event.state as LedgerAgent['state'];
    agent.review = false;
    agent.ended = when;
    agent.outcome = event.outcome ?? null;
    agent.result = event.result ?? null;
  }
  return [...agents.values()];
}

/** Text safe inside a ledger line: its parts are split on " — ". */
const flat = (text: string | null | undefined) => (text ?? '').replace(/\s+—\s+/g, ' - ').trim();

/**
 * The legacy ledger line for what an event did to its run, so a ledger file stays a readable log and the old parser
 * reads it back to the same state. `agent` is the run after the event.
 */
export function ledgerLine(event: AgentEvent, agent: LedgerAgent): string {
  const lane = agent.lane ? ` lane:${agent.lane}` : '';
  const head = `sid:${event.sid8}${lane} ${event.name}`;
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

/** The progress line for a beat, the form beat.sh writes. */
export function beatLine(event: AgentEvent): string {
  const time = ledgerTime(new Date(event.at)).replace(/ ET,.*$/, '');
  const note = event.note ? `: ${event.note}` : '';
  return `- ${time} ${event.name} ${event.n}/${event.of} ${event.step}${note}`;
}

/** An agent's own beat, or the by-name beat a progress file gave (ledger agents only: an events agent never borrows another run's). */
export function beatOf(
  agent: Pick<LedgerAgent, 'name' | 'source' | 'beat'>,
  legacy: Map<string, BoardBeat>,
): BoardBeat | undefined {
  return agent.source === 'events' ? (agent.beat ?? undefined) : legacy.get(agent.name);
}
