/**
 * The agent registry: `once-upon agent start|state|beat|finish` write events to <home>/agents.jsonl (events.ts says
 * what they mean). The store validates, finds the run an event belongs to, and, when the settings name a ledger or a
 * progress file, appends the matching legacy line to it, so those files stay readable logs written by the CLI and not
 * typed by hand. A mirror that fails never fails the write.
 */
import { randomBytes } from 'node:crypto';
import { REPO_RE } from '../config/repos.ts';
import { appendAgentEvent, readAgentsFile } from '../../adapters/stores/agents-file.ts';
import { appendLine } from '../../adapters/stores/notes.ts';
import { lastActivity } from './ledger.ts';
import {
  AGENT_KINDS,
  END_STATES,
  OPEN_STATES,
  STALE_MS,
  beatLine,
  foldAgentEvents,
  ledgerLine,
  parseAgentEvents,
  runIsOpen,
  type AgentEvent,
  type AgentKind,
  type AgentResult,
} from './events.ts';
import { branchTip, madeOnBranch } from './made.ts';
import { agentsFile } from './read.ts';
import type { LedgerAgent } from './ledger.ts';

const NAME_PATTERN = /^[\w.-]{1,100}$/;
const SID_PATTERN = /^[0-9a-f]{8}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const CARD_PATTERN = /^bl_[0-9a-z]{6,20}$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const LANE_PATTERN = /^[\w.-]{1,100}$/;
const STEP_PATTERN = /^[\w.-]{1,40}$/;
const TEXT_MAX = 1000;
/** An editor's slots when it registers with none: the editor skill's own default. */
export const DEFAULT_SLOTS = 3;

/** Text with control characters out, trimmed, or an error when too long. */
function clean(value: unknown, what: string, max = TEXT_MAX): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (text.length > max) {
    throw new Error(`${what} is longer than ${max} characters`);
  }
  return text;
}

function optional(value: unknown, what: string, pattern: RegExp): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  if (!pattern.test(text)) {
    throw new Error(`${what} "${text.slice(0, 60)}" is not valid`);
  }
  return text;
}

function count(value: unknown, what: string, max = 100000): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new Error(`${what} must be a whole number`);
  }
  return number;
}

/** Which run an event is for: a name, and the launching session's first 8 characters when the caller knows them. */
interface Target {
  sid?: string | null;
  /** the caller's own session (first 8), preferred when no sid is given and several sessions have an open run of the name */
  prefer?: string | null;
  /** the run the caller started (`agent start` prints it): an event for any other run is refused */
  run?: string | null;
  at?: Date;
  by?: string | null;
}

export interface StartInput extends Target {
  name: string;
  sid: string;
  /** the launching session's full id, when there is one */
  session?: string | null;
  /** optional on a restart: the id's earlier run's kind carries over */
  kind?: AgentKind;
  /** a standing agent (the backlog clerk): left out, it keeps the earlier run's value; false clears it */
  standing?: boolean;
  task: string;
  model?: string | null;
  effort?: string | null;
  repo?: string | null;
  branch?: string | null;
  pr?: number | string | null;
  cwd?: string | null;
  card?: string | null;
  lane?: string | null;
  notes?: string | null;
  /** an editor's build slots (1..99, default 3); only an editor has them */
  slots?: number | string | null;
}

export interface StateInput extends Target {
  state: (typeof OPEN_STATES)[number];
  outcome?: string | null;
  findings?: number | string | null;
  notes?: string | null;
}

export interface BeatInput extends Target {
  n: number | string;
  of: number | string;
  step: string;
  note?: string | null;
}

export interface FinishInput extends Target {
  state?: (typeof END_STATES)[number];
  outcome?: string | null;
  result?: {
    commit?: string | null;
    pr?: number | string | null;
    branch?: string | null;
    card?: string | null;
  };
  findings?: number | string | null;
  notes?: string | null;
}

/** The files the registry mirrors its events into as legacy lines, from the board settings. */
export interface Mirror {
  ledger: string | null;
  progress: string | null;
}

export class AgentRegistry {
  declare file: string;
  declare mirror: Mirror;

  constructor(home: string, mirror: Mirror = { ledger: null, progress: null }) {
    this.file = agentsFile(home);
    this.mirror = mirror;
  }

  events(): AgentEvent[] {
    return parseAgentEvents(readAgentsFile(this.file));
  }

  /** Every agent the events tell, with its latest run. */
  agents(): LedgerAgent[] {
    return foldAgentEvents(this.events());
  }

  /** Writes the event, then its legacy lines. Returns the run after the event. */
  private append(event: AgentEvent): LedgerAgent {
    appendAgentEvent(this.file, { v: 1, ...event });
    const agent = foldAgentEvents(this.events()).find(
      (one) => `${one.sid}:${one.name}` === event.id,
    );
    try {
      // an editor is not an agent: a `[running]` line that never closes would read as a running agent in the ledger
      if (agent && this.mirror.ledger && event.op !== 'beat' && agent.kind !== 'editor') {
        appendLine(this.mirror.ledger, ledgerLine(event, agent));
      }
      if (this.mirror.progress && event.op === 'beat') {
        appendLine(this.mirror.progress, beatLine(event));
      }
    } catch {
      // the event is written: a view that can't be is not worth failing for
    }
    return agent as LedgerAgent;
  }

  private base(kind: AgentEvent['op'], name: string, sid8: string, target: Target): AgentEvent {
    return {
      op: kind,
      id: `${sid8}:${name}`,
      sid8,
      name,
      at: (target.at ?? new Date()).toISOString(),
      by: clean(target.by, 'the name', 40) || 'cli',
    };
  }

  /**
   * The open run an event is for. With a sid, the exact `sid:name`; with a run id, only that run (the latest of the id: an
   * older one is over). With neither, a subagent calling beat may not know its launcher's session, so: runs that are not
   * stale (no event for STALE_MS), the caller's own session first (`prefer`, from CLAUDE_CODE_SESSION_ID), then the newest.
   * `warn` hears when another session has an open run of the name too.
   */
  private open(name: string, target: Target, warn?: (text: string) => void): LedgerAgent {
    const wanted = optional(target.sid, 'the session id', SID_PATTERN);
    const prefer = wanted ? null : optional(target.prefer, 'the session id', SID_PATTERN);
    const nowMs = (target.at ?? new Date()).getTime();
    const runs = this.agents().filter(
      (one) =>
        one.name === name &&
        (!wanted || one.sid === wanted) &&
        (!target.run || one.run === target.run) &&
        runIsOpen(one) &&
        (wanted || target.run || nowMs - (lastActivity(one)?.getTime() ?? nowMs) <= STALE_MS),
    );
    const rank = (one: LedgerAgent) => Number(one.sid === prefer);
    const best = [...runs].sort(
      (first, second) =>
        rank(second) - rank(first) ||
        (second.started?.getTime() ?? 0) - (first.started?.getTime() ?? 0),
    )[0];
    if (!best) {
      throw new Error(
        `no open run of ${name}${wanted ? ` for session ${wanted}` : ''}${target.run ? ` with run ${target.run}` : ''}: start it first`,
      );
    }
    if (runs.length > 1 && !wanted && best.sid !== prefer) {
      warn?.(
        `once-upon: ${runs.length} open runs named ${name}; using the newest (sid ${best.sid}). Pass --sid to pick one`,
      );
    }
    return best;
  }

  start(input: StartInput): { id: string; run: string } {
    const name = optional(input.name, 'the name', NAME_PATTERN);
    if (!name) {
      throw new Error('a name is needed');
    }
    const sid = optional(input.sid, 'the session id', SID_PATTERN);
    if (!sid) {
      throw new Error('a session id is needed (--sid SID8, or run it from a Claude session)');
    }
    // a restart of the same sid:name keeps what the earlier run was registered as, so a resumed standing agent stays standing
    const earlier = this.agents().find((one) => one.sid === sid && one.name === name);
    const kind = input.kind ?? earlier?.kind;
    if (!kind || !(AGENT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`the kind must be one of ${AGENT_KINDS.join(', ')}`);
    }
    const task = clean(input.task, 'the task');
    if (!task) {
      throw new Error('a task is needed (--task TEXT)');
    }
    const slots = count(input.slots, 'the slots', 99);
    if (slots !== null && (kind !== 'editor' || slots < 1)) {
      throw new Error('--slots is for an editor (--kind editor), 1 to 99');
    }
    const run = `r_${randomBytes(5).toString('hex')}`;
    const pr = count(input.pr, 'the PR number');
    const repo = optional(input.repo, 'the repo', REPO_RE);
    const branch = optional(input.branch, 'the branch', BRANCH_PATTERN);
    const cwd = clean(input.cwd, 'the cwd', 500) || null;
    this.append({
      ...this.base('start', name, sid, input),
      session: clean(input.session, 'the session', 100) || null,
      run,
      kind,
      standing: input.standing ?? earlier?.standing === true,
      task,
      model: clean(input.model, 'the model', 60) || null,
      effort: clean(input.effort, 'the effort', 30) || null,
      repo,
      branch,
      tip: branchTip(cwd, branch, repo),
      pr: pr || null,
      cwd,
      card: optional(input.card, 'the card', CARD_PATTERN),
      lane: optional(input.lane, 'the lane', LANE_PATTERN),
      notes: clean(input.notes, 'the notes path', 500) || null,
      ...(kind === 'editor' ? { slots: slots ?? DEFAULT_SLOTS } : {}),
    });
    return { id: `${sid}:${name}`, run };
  }

  state(name: string, input: StateInput, warn?: (text: string) => void): LedgerAgent {
    if (!(OPEN_STATES as readonly string[]).includes(input.state)) {
      throw new Error(`the state must be one of ${OPEN_STATES.join(', ')}`);
    }
    const agent = this.open(name, input, warn);
    return this.append({
      ...this.base('state', name, agent.sid, input),
      run: agent.run ?? undefined,
      state: input.state,
      outcome: clean(input.outcome, 'the outcome') || null,
      findings: count(input.findings, 'the findings count'),
      notes: clean(input.notes, 'the notes path', 500) || null,
    });
  }

  beat(name: string, input: BeatInput, warn?: (text: string) => void): LedgerAgent {
    const total = count(input.of, 'the beat total', 99);
    const step = Number(input.n);
    const word = String(input.step ?? '');
    if (!total || !Number.isInteger(step) || step < 1 || step > total || !STEP_PATTERN.test(word)) {
      throw new Error('a beat is N/M (1 <= N <= M <= 99) and a one-word step');
    }
    const agent = this.open(name, input, warn);
    return this.append({
      ...this.base('beat', name, agent.sid, input),
      run: agent.run ?? undefined,
      n: step,
      of: total,
      step: word,
      note: clean(input.note, 'the note') || '',
    });
  }

  /** Ends the run. Finishing a run that is already over is refused: a fix round is a new run (`agent start`). */
  finish(name: string, input: FinishInput = {}, warn?: (text: string) => void): LedgerAgent {
    const state = input.state ?? 'done';
    if (!(END_STATES as readonly string[]).includes(state)) {
      throw new Error(`the state must be one of ${END_STATES.join(', ')}`);
    }
    let wanted = optional(input.sid, 'the session id', SID_PATTERN);
    const prefer =
      wanted || input.run ? null : optional(input.prefer, 'the session id', SID_PATTERN);
    const ofName = this.agents().filter((one) => one.name === name);
    // without --sid, the caller's own session's runs when it has any (stale or not): another session's run of the name is
    // never its to end, and `open()` is told so it cannot fall through to one
    if (prefer && ofName.some((one) => one.sid === prefer)) {
      wanted = prefer;
    } else if (!wanted && !input.run) {
      // none of the caller's own: refuse when several sessions have a live run (open and not stale, as `open()` counts them)
      const nowMs = (input.at ?? new Date()).getTime();
      const live = new Set(
        ofName
          .filter(
            (one) => runIsOpen(one) && nowMs - (lastActivity(one)?.getTime() ?? nowMs) <= STALE_MS,
          )
          .map((one) => one.sid),
      );
      if (live.size > 1) {
        throw new Error(
          `${name} has open runs in more than one session (${[...live].join(', ')}) and this session is not one of them: pass --sid to say which to finish`,
        );
      }
    }
    const named = ofName.filter((one) => !wanted || one.sid === wanted);
    if (named.length && !named.some(runIsOpen)) {
      throw new Error(
        `${name} has already finished, so this finish (and any --commit on it) was not recorded: run \`agent start\` for a new run (a fix round is one), then finish that`,
      );
    }
    const agent = this.open(name, { ...input, sid: wanted }, warn);
    const result: AgentResult = {};
    const given = input.result ?? {};
    const commit = optional(given.commit, 'the commit', SHA_PATTERN);
    const pr = count(given.pr, 'the PR number');
    const branch = optional(given.branch, 'the branch', BRANCH_PATTERN);
    const card = optional(given.card, 'the card', CARD_PATTERN);
    if (commit) {
      result.commit = commit;
    }
    if (pr) {
      result.pr = pr;
    }
    if (branch) {
      result.branch = branch;
    }
    if (card) {
      result.card = card;
    }
    // none given: what a builder's registered branch gained since the run started. A run that failed or was stopped made
    // nothing to point at, and a helper, reviewer or researcher never takes an author's commit
    if (!Object.keys(result).length && state === 'done' && agent.kind === 'builder') {
      Object.assign(result, madeOnBranch(agent));
    }
    return this.append({
      ...this.base('finish', name, agent.sid, input),
      run: agent.run ?? undefined,
      state,
      outcome: clean(input.outcome, 'the outcome') || null,
      result: Object.keys(result).length ? result : null,
      findings: count(input.findings, 'the findings count'),
      notes: clean(input.notes, 'the notes path', 500) || null,
    });
  }
}
