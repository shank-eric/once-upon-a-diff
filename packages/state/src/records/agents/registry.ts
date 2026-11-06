/**
 * The agent registry: `once-upon agent start|state|beat|finish` write events to <home>/agents.jsonl (events.ts says
 * what they mean). The store validates, finds the run an event belongs to, and, when the settings name a ledger or a
 * progress file, appends the matching line to it, so those files stay readable logs for people and scripts, written by
 * the CLI and not typed by hand. The board never reads them back. A mirror that fails never fails the write.
 */
import {
  BACKLOG_ID_RE,
  AGENT_NAME_RE,
  CARD_BRANCH_RE,
  SID_RE,
} from '@once-upon-a-diff/domain/patterns';
import { SHA_RE } from '@once-upon-a-diff/domain/text';
import { REPO_RE } from '@once-upon-a-diff/foundation/repos';
import { agentId, sameRepo } from '@once-upon-a-diff/domain/ids';
import { newRunId } from '@once-upon-a-diff/foundation/ids';
import { appendAgentEvent } from '@once-upon-a-diff/adapters/stores/agents-file';
import { agentEventsIn } from './events-file.ts';
import { appendLine } from '@once-upon-a-diff/adapters/stores/fs/lines';
import { checkWrite } from '@once-upon-a-diff/foundation/shared-files';
import { readAgentEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { strictAgentEvent } from '@once-upon-a-diff/contracts/files/strict';
import { lastActivity } from './ledger.ts';
import { AGENT_KINDS, type AgentKind, type AgentResult } from './agent-types.ts';
import {
  KIND_ALIASES,
  canonicalKind,
  END_STATES,
  OPEN_STATES,
  STALE_MS,
  beatLine,
  foldAgentEvents,
  ledgerLine,
  runIsOpen,
  type AgentEvent,
} from './events.ts';
import { branchTip, madeOnBranch } from './made.ts';
import { agentsFile } from './read.ts';
import { clean, count, optional } from '@once-upon-a-diff/foundation/input';
import type { LedgerAgent } from './ledger.ts';

const STEP_PATTERN = /^[\w.-]{1,40}$/;
/** An editor's slots when it registers with none: the editor skill's own default. */
export const DEFAULT_SLOTS = 3;

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
  /** an old name (`builder`, `reviewer`) is accepted and stored as its new one */
  kind?: AgentKind | keyof typeof KIND_ALIASES;
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

/** The states a sweep closes: a run that owes beats. One parked on a person (waiting, review, plan) is never swept. */
const SWEPT_STATES: LedgerAgent['state'][] = ['running', 'fixing'];
/**
 * The kinds a sweep closes: work and check runs (an author's, a critic's), which beat. A helper of any kind is never swept: it
 * idles between requests, a storyteller registers as one, and the live editor skill still registers the editor as one.
 */
const SWEPT_KINDS: (LedgerAgent['kind'] & string)[] = ['author', 'critic'];

/** The files the registry mirrors its events into as log lines, from the board settings. */
export interface Mirror {
  ledger: string | null;
  progress: string | null;
}

/** What the registry needs of a backlog card to check a run that names it (the backlog is a tier above the registry's, so the caller supplies it). */
export interface CardFacts {
  id: string;
  /** dropped or landed: no run may start on it */
  closed: 'dropped' | 'landed' | null;
  repo: string | null;
  branch: string | null;
  /** whether an agent has claimed it */
  claimed: boolean;
}
export type CardLookup = (id: string) => CardFacts | null;

export class AgentRegistry {
  declare file: string;
  declare mirror: Mirror;
  declare cards: CardLookup | null;

  /**
   * `cards` turns on the checks a run that names a card gets (ADR-25): the card must exist and be open, repo and branch come
   * from the card, a critic needs a card, one author at a time per card, and a carded critic finishes with a findings count.
   * Without it the registry only records, as it did before.
   */
  constructor(
    home: string,
    mirror: Mirror = { ledger: null, progress: null },
    cards: CardLookup | null = null,
  ) {
    this.file = agentsFile(home);
    this.mirror = mirror;
    this.cards = cards;
  }

  events(): AgentEvent[] {
    return agentEventsIn(this.file);
  }

  /** Every agent the events tell, with its latest run. */
  agents(): LedgerAgent[] {
    return foldAgentEvents(this.events());
  }

  /** Writes the event, then its log lines. Returns the run after the event. */
  private append(event: AgentEvent): LedgerAgent {
    const line = { v: 1, ...event };
    checkWrite(this.file, line, readAgentEvent, strictAgentEvent);
    appendAgentEvent(this.file, line);
    const agent = foldAgentEvents(this.events()).find(
      (one) => agentId(one.sid, one.name) === event.id,
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
      id: agentId(sid8, name),
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
    const wanted = optional(target.sid, 'the session id', SID_RE);
    const prefer = wanted ? null : optional(target.prefer, 'the session id', SID_RE);
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

  /**
   * Closes the runs that have gone quiet: open and `running` or `fixing` (they owe beats), with no event for STALE_MS, each by a
   * `finish --state stopped --by sweep` so the ledger's last line for it closes. Never a run parked on a person (waiting, review
   * or plan: a weekend over a question is not a dead run, and finishing it would refuse its own finish when it resumes), a
   * helper of any kind, a researcher or an editor (an editor beats nothing while its authors work). Only authors and critics are
   * closed (SWEPT_KINDS). Returns the runs it
   * closed (or, with `dryRun`, would). Only the CLI calls it, on `agent start` and `agent sweep`: a board read never writes.
   */
  sweep(options: { at?: Date; dryRun?: boolean } = {}): LedgerAgent[] {
    const now = options.at ?? new Date();
    const swept: LedgerAgent[] = [];
    for (const agent of this.agents()) {
      const sign = lastActivity(agent)?.getTime() ?? now.getTime();
      if (
        !SWEPT_STATES.includes(agent.state) ||
        !SWEPT_KINDS.includes(agent.kind as never) ||
        agent.standing ||
        now.getTime() - sign <= STALE_MS
      ) {
        continue;
      }
      if (!options.dryRun) {
        try {
          this.finish(agent.name, {
            sid: agent.sid,
            run: agent.run,
            state: 'stopped',
            outcome: 'no sign of life for 24 hours',
            by: 'sweep',
            at: now,
          });
        } catch {
          // another writer closed it first: the run is over either way
          continue;
        }
      }
      swept.push(agent);
    }
    return swept;
  }

  start(input: StartInput, warn?: (text: string) => void): { id: string; run: string } {
    const name = optional(input.name, 'the name', AGENT_NAME_RE);
    if (!name) {
      throw new Error('a name is needed');
    }
    const sid = optional(input.sid, 'the session id', SID_RE);
    if (!sid) {
      throw new Error('a session id is needed (--sid SID8, or run it from a Claude session)');
    }
    // a restart of the same sid:name keeps what the earlier run was registered as, so a resumed standing agent stays standing
    const earlier = this.agents().find((one) => one.sid === sid && one.name === name);
    const kind = canonicalKind(input.kind ?? earlier?.kind);
    if (!kind) {
      throw new Error(
        `the kind must be one of ${AGENT_KINDS.join(', ')} (builder and reviewer still work)`,
      );
    }
    const task = clean(input.task, 'the task');
    if (!task) {
      throw new Error('a task is needed (--task TEXT)');
    }
    const slots = count(input.slots, 'the slots', 99);
    if (slots !== null && (kind !== 'editor' || slots < 1)) {
      throw new Error('--slots is for an editor (once-upon editor start --slots N), 1 to 99');
    }
    const run = newRunId();
    let pr = count(input.pr, 'the PR number');
    let repo = optional(input.repo, 'the repo', REPO_RE);
    let branch = optional(input.branch, 'the branch', CARD_BRANCH_RE);
    let lane = optional(input.lane, 'the lane', AGENT_NAME_RE);
    const cwd = clean(input.cwd, 'the cwd', 500) || null;
    // a restart of the same sid:name (a fix round) stays on the earlier run's card, as the kind does, while that card is open
    let cardId = optional(input.card, 'the card', BACKLOG_ID_RE);
    if (!cardId && earlier?.card && (!this.cards || this.cards(earlier.card)?.closed === null)) {
      cardId = earlier.card;
    }
    if (this.cards && kind === 'critic' && !cardId) {
      throw new Error(
        'a critic reviews a card: pass --card ID (once-upon backlog list shows the ids). Without it the board cannot tie the review to its work',
      );
    }
    if (this.cards && cardId) {
      const card = this.cards(cardId);
      if (!card) {
        throw new Error(`no backlog card ${cardId}`);
      }
      if (card.closed) {
        throw new Error(`${cardId} is ${card.closed}: a run cannot start on it`);
      }
      if (kind === 'author') {
        const key = agentId(sid, name);
        const nowMs = (input.at ?? new Date()).getTime();
        // a restart of the same sid:name is a fix round and ends the run before it; any other open author on the card is a second one
        const other = this.agents().find(
          (one) =>
            one.card === cardId &&
            one.kind === 'author' &&
            agentId(one.sid, one.name) !== key &&
            // an author parked at a question or a story review is not working, so it does not block a fixer
            ['running', 'plan', 'fixing'].includes(one.state) &&
            nowMs - (lastActivity(one)?.getTime() ?? nowMs) <= STALE_MS,
        );
        if (other) {
          throw new Error(
            `${cardId} already has an open author run (${agentId(other.sid, other.name)}): finish it first, or restart it under its own name for a fix round`,
          );
        }
        if (!card.claimed) {
          warn?.(
            `once-upon: ${cardId} has no claim yet: once-upon backlog claim ${cardId} --agent ${name}`,
          );
        }
      }
      // the card's repo and branch are the run's: a typed one that differs is not used, and is said so
      const typed = { repo, branch, pr, lane };
      if (card.repo && repo && !sameRepo(repo, card.repo)) {
        warn?.(`once-upon: --repo ${repo} ignored: ${cardId} is on ${card.repo}`);
      }
      if (card.branch && branch && branch !== card.branch) {
        warn?.(`once-upon: --branch ${branch} ignored: ${cardId} is on ${card.branch}`);
      }
      if (typed.pr || typed.lane) {
        warn?.(
          'once-upon: --pr and --lane are ignored for a run on a card: they come from the card',
        );
      }
      repo = card.repo ?? repo;
      branch = card.branch ?? branch;
      pr = null;
      lane = null;
    }
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
      card: cardId,
      lane,
      notes: clean(input.notes, 'the notes path', 500) || null,
      // a restart that leaves --slots out keeps the editor's earlier slots
      ...(kind === 'editor' ? { slots: slots ?? earlier?.slots ?? DEFAULT_SLOTS } : {}),
    });
    return { id: agentId(sid, name), run };
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
    let wanted = optional(input.sid, 'the session id', SID_RE);
    const prefer = wanted || input.run ? null : optional(input.prefer, 'the session id', SID_RE);
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
    // a null count reads as a pass, so a critic on a card must say how many (0 is fine)
    if (
      this.cards &&
      agent.kind === 'critic' &&
      agent.card &&
      state === 'done' &&
      count(input.findings, 'the findings count') === null
    ) {
      throw new Error(
        'a critic finishes with its findings count: --findings N (0 if it found none). Without one the card would read as passed',
      );
    }
    const result: AgentResult = {};
    const given = input.result ?? {};
    const commit = optional(given.commit, 'the commit', SHA_RE);
    const pr = count(given.pr, 'the PR number');
    const branch = optional(given.branch, 'the branch', CARD_BRANCH_RE);
    const card = optional(given.card, 'the card', BACKLOG_ID_RE);
    // a run that started on a card finishes on it. One that started with none may name its card here, and nothing is said.
    if (card && agent.card && card !== agent.card) {
      warn?.(`once-upon: --card ${card} is not the card ${name} started on (${agent.card})`);
    } else if (card && this.cards && !this.cards(card)) {
      warn?.(`once-upon: --card ${card} is not a backlog card`);
    }
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
    // none given: what an author's registered branch gained since the run started. A run that failed or was stopped made
    // nothing to point at, and a helper, critic or researcher never takes an author's commit
    if (!Object.keys(result).length && state === 'done' && agent.kind === 'author') {
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
