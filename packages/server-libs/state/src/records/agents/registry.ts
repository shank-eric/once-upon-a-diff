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
} from '@once-upon-a-diff/terms/patterns';
import { SHA_RE } from '@once-upon-a-diff/terms/text';
import { REPO_RE } from '@once-upon-a-diff/foundation/repos';
import { agentId, isImplicitCard, isSelfName } from '@once-upon-a-diff/terms/ids';
import { newImplicitCardId, newRunId } from '@once-upon-a-diff/foundation/ids';
import { appendAgentEvent } from '@once-upon-a-diff/adapters/stores/agents-file';
import { agentEventsIn } from './events-file.ts';
import { appendLine } from '@once-upon-a-diff/adapters/stores/fs/lines';
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { checkWrite } from '@once-upon-a-diff/foundation/shared-files';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { END_STATES, OPEN_STATES } from '@once-upon-a-diff/contracts/files/agent-states';
import { readAgentEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { strictAgentEvent } from '@once-upon-a-diff/contracts/files/strict';
import { lastActivity } from './ledger.ts';
import { SWEPT_STATES, canAutoEnd, endOfStopped, quietSign } from './auto-end.ts';
import { livenessKey } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import { AGENT_KINDS, type AgentKind, type AgentResult, type AgentRole } from './agent-types.ts';
import {
  KIND_ALIASES,
  canonicalKind,
  STALE_MS,
  QUIET_MS,
  beatLine,
  foldAgentEvents,
  ledgerLine,
  runIsOpen,
  type AgentEvent,
} from './events.ts';
import { implicitCards } from './implicit.ts';
import {
  commitOf,
  defaultBranchOf,
  isAncestor,
  worktreeFacts,
} from '@once-upon-a-diff/adapters/git';
import { branchTip, madeOnBranch, uncommittedWorktree } from './made.ts';
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
  /** with a card checked (ADR-25): no card named and none to carry over mints an implicit card, unless this says not to (ADR-27) */
  newCard?: boolean;
  /** the id of the card the caller already stored for the run this start would mint (ADR-29); used in place of a fresh `ic_` id */
  mintedCard?: string | null;
  /** the caller claims the card for this author once the start is accepted (a start that joined an unclaimed card): the claim check is waived */
  claimsOnStart?: boolean;
  /** what the run does on a card (`--role`): checked at start, and kept on the start row (a fixer's finish can carry an approval) */
  role?: AgentRole | null;
  /** the name of the earlier run of this session that this one retries: once this run is done, a failed one of that name is off the board */
  replaces?: string | null;
  /** a typed `--lane`: nothing reads a lane tag (a run's lane is its repo's), so it is refused beside a card and otherwise warned about */
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
  /** told --no-commit (a planner or capped author): there is no commit to wait for, so the worktree is not read */
  noCommit?: boolean;
  /** called with the run and its result just before the finish row is written: where the caller writes what the result taught the card (its branch), so no board built between the two writes sees the card without it */
  beforeFinish?: (agent: LedgerAgent, result: AgentResult) => void;
}

/**
 * The kinds a sweep closes: work and check runs (an author's, a critic's), which beat. A helper of any kind is never swept: it
 * idles between requests, and the live editor skill still registers the editor as one. A storyteller is not swept either: the board
 * drops its gate when it has been silent for STALE_MS (board/stages/agents.ts).
 */
/** The events that are no ledger line: a beat goes to the progress file, and a branch or card move or an ack tells nothing a run did. */
const NOT_LEDGER_LINES: ReadonlySet<string> = new Set(['beat', 'branch', 'card', 'ack']);

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
  /** the checkout the card's work is in, when a link says (ADR-29): where a finish reads git */
  worktree?: string | null;
}

/**
 * Whether a start with no card to carry over makes one (ADR-27, ADR-29): a critic, a storyteller and an editor work on cards that
 * exist, a fixer too, and a standing agent is no work. The one rule: the registry mints by it, and the caller that stores the card first asks it.
 */
export const mintsCard = (run: {
  cardId: string | null;
  standing: boolean;
  kind: string;
  role?: string | null;
}): boolean =>
  !run.cardId &&
  !run.standing &&
  !['critic', 'storyteller', 'editor'].includes(run.kind) &&
  !['critic', 'fixer', 'storyteller'].includes(run.role ?? '');
export type CardLookup = (id: string) => CardFacts | null;

/**
 * The flags typed beside a card that the card already answers (ADR-25, the flip): its repo, its branch, a PR when it has a
 * branch, and any lane (a lane tag is read by nothing). A card with no repo or branch yet keeps the typed one, which the stamp
 * and the commit check need. The CLI adds `--kind`, which only it can tell from a role.
 */
export function flagsBesideCard(
  card: Pick<CardFacts, 'repo' | 'branch'>,
  typed: { repo?: string | null; branch?: string | null; pr?: unknown; lane?: string | null },
): string[] {
  return [
    typed.repo && card.repo ? '--repo' : '',
    typed.branch && card.branch ? '--branch' : '',
    typed.pr && card.branch ? '--pr' : '',
    typed.lane ? '--lane' : '',
  ].filter(Boolean);
}

/** The refusal for those flags: what a run on a card takes from the card. */
export const flagsBesideCardError = (flags: string[]): Error =>
  new Error(
    `${flags.join(', ')} ${flags.length > 1 ? 'are' : 'is'} not taken with --card: the card gives the run its repo and branch, and --role says what it does. Drop ${flags.length > 1 ? 'them' : 'it'} (--role author|fixer|critic|storyteller|helper|research; once-upon backlog branch <id> <name> changes the card's branch)`,
  );

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
      // (a branch or card move or an ack is not a line either: the ledger tells what a run did, and a move is not one of those)
      if (
        agent &&
        this.mirror.ledger &&
        !NOT_LEDGER_LINES.has(event.op) &&
        agent.kind !== 'editor'
      ) {
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
   * helper of any kind, a storyteller, a researcher, a parent session's own run (`--self`) or an editor (an editor beats nothing while its authors work). Only authors and critics are
   * closed (SWEPT_KINDS). A parent session's own run is the one exception to the quiet rule: it is closed `stopped` (outcome "its
   * session ended") when `liveSids` (the first 8 of each live Claude session's id) is given, is not empty and lacks its session. An
   * empty or absent list closes nothing: it is a scan that found nothing or could not be trusted, not proof every session left.
   * A run with an entry in `lastWrite` (its transcript's last write, per `quietSign`) is instead ended QUIET_MS after its last sign of
   * life, `failed` by `auto-finish` (so its own later finish replaces it); one with none keeps the STALE_MS rule above.
   * Returns the runs it closed (or, with `dryRun`, would). Only the CLI calls it, on `agent start`, `agent sweep` and `card status`: a board read never writes.
   */
  sweep(
    options: {
      at?: Date;
      dryRun?: boolean;
      liveSids?: readonly string[];
      /** The adapter's last transcript write per run (ms, keyed `sid:name`): an author or critic with an entry is judged by QUIET_MS, one without by STALE_MS. */
      lastWrite?: ReadonlyMap<string, number>;
    } = {},
  ): LedgerAgent[] {
    const now = options.at ?? new Date();
    const swept: LedgerAgent[] = [];
    const live = options.liveSids;
    for (const agent of this.agents()) {
      const sign = lastActivity(agent)?.getTime() ?? now.getTime();
      const judged =
        !isSelfName(agent.name) && SWEPT_KINDS.includes(agent.kind as never) && !agent.standing;
      const transcript = judged
        ? quietSign(agent, options.lastWrite?.get(livenessKey(agent)))
        : null;
      // a parent session's own run beats no one while it works, so it is never quiet: it ends when its session is gone
      const self = isSelfName(agent.name);
      const gone = self && runIsOpen(agent) && !!live?.length && !live.includes(agent.sid);
      if (
        self
          ? !gone
          : !SWEPT_STATES.includes(agent.state) ||
            !SWEPT_KINDS.includes(agent.kind as never) ||
            agent.standing ||
            (transcript === null
              ? now.getTime() - sign <= STALE_MS
              : now.getTime() - transcript <= QUIET_MS)
      ) {
        continue;
      }
      if (!options.dryRun) {
        try {
          this.finish(agent.name, {
            sid: agent.sid,
            run: agent.run,
            ...(transcript === null
              ? {
                  state: 'stopped' as const,
                  outcome: self ? 'its session ended' : 'no sign of life for 24 hours',
                  by: 'sweep',
                  at: now,
                }
              : {
                  ...endOfStopped(agent),
                  // auto-finish, not sweep: the run's own later finish replaces it, so a live run judged dead is never locked out
                  by: 'auto-finish',
                  at: new Date(transcript + QUIET_MS),
                }),
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

  /**
   * Ends the run of `sid:name` whose subagent has stopped without finishing it (the SubagentStop hook, `agent auto-finish`):
   * `finish --by auto-finish`: an author's or a critic's run (work that owes a commit or findings) is `failed`, outcome
   * "stopped without agent finish", so its card shows a failure and not a Done it never reported; any other kind (a helper,
   * researcher, storyteller) is `done`, outcome `auto-finished`. Only a run still `running` or `fixing`: never one parked on a
   * person (plan, waiting, review), one already over, a standing helper, an editor or a parent session's own run (`--self`),
   * which idle between requests by design. A later finish by the agent replaces this one (events.ts). Returns the run it ended, or null when it ended none.
   */
  autoFinish(sid: string, name: string): LedgerAgent | null {
    const agent = this.agents().find((one) => one.sid === sid && one.name === name);
    if (!agent?.run || !canAutoEnd(agent)) {
      return null;
    }
    const end = endOfStopped(agent);
    try {
      return this.finish(name, {
        sid,
        run: agent.run,
        state: end.state,
        outcome: end.outcome,
        by: 'auto-finish',
      });
    } catch {
      // another writer ended it first: the run is over either way
      return null;
    }
  }

  /**
   * The card an id names, as a run on it needs it: the backlog's first (an adopted implicit card is a backlog item that can be
   * dropped or landed, and then takes no runs), else, for an `ic_` id, the implicit card the registry's own runs made (always
   * open, its first run's repo and its latest branch). Null when no card has the id, so a made-up `ic_` id is refused.
   */
  private cardFacts(id: string): CardFacts | null {
    const real = this.cards?.(id) ?? null;
    if (real || !isImplicitCard(id)) {
      return real;
    }
    const card = implicitCards(this.agents()).find((one) => one.id === id);
    return card ? { id, closed: null, repo: card.repo, branch: card.branch, claimed: true } : null;
  }

  /**
   * The card a start names or carries over, and whether it makes one: a restart of the same sid:name (a fix round) stays on the
   * earlier run's card, as the kind does, while that card is open.
   */
  private cardFor(
    input: StartInput,
    earlier: LedgerAgent | undefined,
    kind: string,
  ): { cardId: string | null; standing: boolean; mints: boolean } {
    let cardId = optional(input.card, 'the card', BACKLOG_ID_RE);
    const stillOpen = (card: string) => !this.cards || this.cardFacts(card)?.closed === null;
    if (!cardId && !input.newCard && earlier?.card && stillOpen(earlier.card)) {
      cardId = earlier.card;
    }
    const standing = input.standing ?? earlier?.standing === true;
    return { cardId, standing, mints: mintsCard({ cardId, standing, kind, role: input.role }) };
  }

  /**
   * Whether `start(input)` would make a card for this run (and so the caller stores it first). False for an input the start
   * would refuse: nothing is made for it.
   */
  wouldMint(input: StartInput): boolean {
    try {
      const name = optional(input.name, 'the name', AGENT_NAME_RE);
      const sid = optional(input.sid, 'the session id', SID_RE);
      const earlier = this.agents().find((one) => one.sid === sid && one.name === name);
      const kind = canonicalKind(input.kind ?? earlier?.kind);
      return !!this.cards && !!name && !!sid && !!kind && this.cardFor(input, earlier, kind).mints;
    } catch {
      return false;
    }
  }

  /** Registers a run. The checks and the append are one step under the log's lock: two starts at once see each other (one open author per card). */
  start(
    input: StartInput,
    warn?: (text: string) => void,
  ): { id: string; run: string; card: string | null } {
    return withLock(this.file, () => this.startLocked(input, warn));
  }

  private startLocked(
    input: StartInput,
    warn?: (text: string) => void,
  ): { id: string; run: string; card: string | null } {
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
    const typedLane = input.lane?.trim() || null;
    const replaces = optional(input.replaces, 'the replaced run', AGENT_NAME_RE);
    if (replaces === name) {
      throw new Error('--replaces names an earlier run: it cannot be this run');
    }
    const cwd = clean(input.cwd, 'the cwd', 500) || null;
    const { cardId: carried, standing, mints: wouldMint } = this.cardFor(input, earlier, kind);
    let cardId = carried;
    const mints = !!this.cards && wouldMint;
    if (mints && kind === 'author' && !branch) {
      throw new Error(
        'an author with no card needs --branch (the branch its work is on, which names its card) or --card ID',
      );
    }
    if (this.cards && input.role === 'fixer' && !cardId) {
      throw new Error('a fixer works on a card: pass --card ID');
    }
    if (mints) {
      cardId = optional(input.mintedCard, 'the minted card', BACKLOG_ID_RE) ?? newImplicitCardId();
    }
    if (this.cards && kind === 'critic' && !cardId) {
      throw new Error(
        'a critic reviews a card: pass --card ID (once-upon backlog list shows the ids). Without it the board cannot tie the review to its work',
      );
    }
    // a storyteller with no card is let through when it has a branch to read (--pr N or --branch NAME): its story is the work card
    if (this.cards && kind === 'storyteller' && !cardId && !branch) {
      throw new Error(
        'a storyteller tells a card’s story: pass --card ID (once-upon backlog list shows the ids), --pr N or --branch NAME. Without one the board cannot tie the story to its work',
      );
    }
    // a card the caller stored for this start has no runs, unless a start that joined it got in first: two authors on one card
    // are the same refusal there
    if (mints && cardId && kind === 'author' && input.mintedCard) {
      this.refuseSecondAuthor(cardId, sid, name, input.at);
    }
    if (this.cards && cardId && !mints) {
      const card = this.cardFacts(cardId);
      if (!card) {
        throw new Error(`no backlog card ${cardId}`);
      }
      if (card.closed) {
        throw new Error(`${cardId} is ${card.closed}: a run cannot start on it`);
      }
      if (kind === 'author') {
        this.refuseSecondAuthor(cardId, sid, name, input.at);
        // the claim comes before the first start: the launcher claims the card for the agent, then registers it
        if (!card.claimed && !input.claimsOnStart) {
          throw new Error(
            `${cardId} has no claim: claim it first, once-upon backlog claim ${cardId} --agent ${name} (the claim comes before agent start)`,
          );
        }
      }
      // the card's repo and branch are the run's: a typed one is refused, not guessed over. A card carried over from the
      // earlier run takes no typed branch, PR or lane either; its repo is filled from the checkout, so it is not "typed"
      const flags = flagsBesideCard(card, {
        repo: input.card ? repo : null,
        branch,
        pr,
        lane: typedLane,
      });
      if (flags.length) {
        throw flagsBesideCardError(flags);
      }
      repo = card.repo ?? repo;
      branch = card.branch ?? branch;
      pr = null;
      // a critic or a storyteller has to have work to read: a card with no branch has none
      if (
        (kind === 'critic' || kind === 'storyteller' || input.role === 'storyteller') &&
        !branch
      ) {
        throw new Error(
          `no branch on ${cardId}: backlog branch ${cardId} <branch>, or agent start ${name} --card ${cardId} --pr N`,
        );
      }
    }
    if (typedLane) {
      warn?.('once-upon: --lane is ignored: a run’s lane is its repo’s');
    }
    this.append({
      ...this.base('start', name, sid, input),
      session: clean(input.session, 'the session', 100) || null,
      run,
      kind,
      standing,
      task,
      model: clean(input.model, 'the model', 60) || null,
      effort: clean(input.effort, 'the effort', 30) || null,
      repo,
      branch,
      tip: branchTip(cwd, branch, repo),
      pr: pr || null,
      cwd,
      card: cardId,
      ...(replaces ? { replaces } : {}),
      ...(input.role ? { role: input.role } : {}),
      notes: clean(input.notes, 'the notes path', 500) || null,
      // a restart that leaves --slots out keeps the editor's earlier slots
      ...(kind === 'editor' ? { slots: slots ?? earlier?.slots ?? DEFAULT_SLOTS } : {}),
    });
    return { id: agentId(sid, name), run, card: cardId };
  }

  /** Refuses an author start when another author of the card is open (a restart of the same sid:name is a fix round, not a second). */
  private refuseSecondAuthor(cardId: string, sid: string, name: string, when?: Date): void {
    const key = agentId(sid, name);
    const nowMs = (when ?? new Date()).getTime();
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
        `${cardId} already has an open author run (${agentId(other.sid, other.name)}): finish it first, then start the fixer or the next author under a fresh name`,
      );
    }
  }

  state(name: string, input: StateInput, warn?: (text: string) => void): LedgerAgent {
    if (!(OPEN_STATES as readonly string[]).includes(input.state)) {
      throw new Error(`the state must be one of ${OPEN_STATES.join(', ')}`);
    }
    let agent: LedgerAgent;
    try {
      agent = this.open(name, input, warn);
    } catch (error) {
      // a state after the hook's auto-finish is accepted like a finish (the stop was not the end after all)
      const wanted = optional(input.sid, 'the session id', SID_RE);
      const prefer = wanted ? null : optional(input.prefer, 'the session id', SID_RE);
      const ended = this.agents().filter(
        (one) =>
          one.name === name &&
          one.autoFinished &&
          (!wanted || one.sid === wanted) &&
          (!input.run || one.run === input.run),
      );
      const own = ended.filter((one) => one.sid === prefer);
      const found = (own.length ? own : ended).sort(
        (first, second) => (second.ended?.getTime() ?? 0) - (first.ended?.getTime() ?? 0),
      )[0];
      if (!found) {
        throw error;
      }
      agent = found;
    }
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
    if (!total || !Number.isInteger(step) || step < 1 || step > total) {
      throw new Error('a beat is N/M (1 <= N <= M <= 99) and a one-word step');
    }
    if (!STEP_PATTERN.test(word)) {
      // The progress line reads `N/M STEP: NOTE`, with the step as one token, so a several-word step is refused.
      throw new Error(
        `the step is one word of letters, digits, . _ - (up to 40 characters), got '${word}'; the progress line reads N/M STEP: NOTE, so put the rest in the note: beat NAME N/M code "what you are doing"`,
      );
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

  /**
   * `beat`, except that a beat with no open run to land on (the agent was never registered, or its run is over) still goes to
   * the progress file: the line is what the subagent panel shows, and a beat must not be lost for a missing registration.
   * Returns whether the beat landed on a run; the reason it did not is passed to `warn`. A beat that is not a beat still throws.
   */
  beatOrLog(name: string, input: BeatInput, warn?: (text: string) => void): boolean {
    if (!AGENT_NAME_RE.test(name)) {
      throw new Error('the name is one word of letters, digits, . _ -');
    }
    try {
      this.beat(name, input, warn);
      return true;
    } catch (err) {
      if (!(err as Error).message.startsWith('no open run')) {
        throw err;
      }
      if (this.mirror.progress) {
        appendLine(
          this.mirror.progress,
          beatLine({
            name,
            n: Number(input.n),
            of: Number(input.of),
            step: input.step,
            note: clean(input.note, 'the note') || '',
            at: (input.at ?? new Date()).toISOString(),
          }),
        );
      }
      warn?.(
        `once-upon: ${(err as Error).message}${this.mirror.progress ? '; the beat is in the progress file only' : ''}`,
      );
      return false;
    }
  }

  /**
   * Moves the open run to another branch (its author renamed or switched it): the run's own `branch` is what the agent
   * registered, and the card's is what the board reads (ADR-25), so `backlog branch` calls this for each open run of the card.
   * The same branch writes nothing. A run that is over is refused, like any event.
   */
  setBranch(name: string, branch: string, target: Target = {}): LedgerAgent {
    const next = optional(branch, 'the branch', CARD_BRANCH_RE);
    if (!next) {
      throw new Error('a branch is needed');
    }
    const agent = this.open(name, target);
    if (agent.branch === next) {
      return agent;
    }
    return this.append({
      ...this.base('branch', name, agent.sid, target),
      run: agent.run ?? undefined,
      branch: next,
    });
  }

  /**
   * Moves one run, open or over, to another card (`backlog drop --into`): the card a run names is what the board reads (ADR-25), and
   * an event cannot be changed, so a move is its own event. A run with no run id cannot be named, so it is refused.
   */
  setCard(run: LedgerAgent, card: string, target: Target = {}): void {
    if (!run.run) {
      throw new Error(
        `${run.name} has a run with no run id, so it cannot be moved: finish it, then drop the card by hand`,
      );
    }
    this.append({
      ...this.base('card', run.name, run.sid, target),
      run: run.run,
      card,
    });
  }

  /**
   * Acknowledges a failed run (`agent ack`): the board stops counting it as failed, and nothing else about it changes. The latest
   * run of `sid:name` (several sessions with a failed run of the name need the sid). Only a failed run can be acked; an acked one is
   * left as it is. Returns the run, and whether this call acked it.
   */
  ack(name: string, input: Target = {}): { run: LedgerAgent; acked: boolean } {
    const wanted = optional(input.sid, 'the session id', SID_RE);
    const named = this.agents().filter(
      (one) => one.name === name && (!wanted || one.sid === wanted),
    );
    if (!named.length) {
      throw new Error(`no run of ${name}${wanted ? ` for session ${wanted}` : ''}`);
    }
    const sids = new Set(named.filter((one) => one.state === 'failed').map((one) => one.sid));
    if (!wanted && sids.size > 1) {
      throw new Error(
        `${name} has a failed run in more than one session (${[...sids].join(', ')}): pass --sid to say which to acknowledge`,
      );
    }
    const run = named.find((one) => one.state === 'failed');
    if (!run) {
      throw new Error(`only a failed run is acknowledged: ${name} is ${named[0].state}`);
    }
    if (run.acked) {
      return { run, acked: false };
    }
    if (!run.run) {
      throw new Error(`${name} has a run with no run id, so it cannot be acknowledged`);
    }
    this.append({ ...this.base('ack', name, run.sid, input), run: run.run });
    return {
      run: this.agents().find((one) => one.sid === run.sid && one.name === name) ?? run,
      acked: true,
    };
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
    // the agent's own finish replaces the hook's (`agent auto-finish`): the stop was not the end after all, or the agent finishes late
    const autoFinished =
      input.by === 'auto-finish'
        ? undefined
        : named.find((one) => one.autoFinished && (!input.run || one.run === input.run));
    if (named.length && !named.some(runIsOpen) && !autoFinished) {
      throw new Error(
        `${name} has already finished, so this finish (and any --commit on it) was not recorded: run \`agent start\` for a new run (a fix round is one), then finish that`,
      );
    }
    const agent =
      autoFinished && !named.some(runIsOpen)
        ? autoFinished
        : this.open(name, { ...input, sid: wanted }, warn);
    // a null count reads as a pass, so a critic on a card must say how many (0 is fine)
    const criticOnCard = this.cards && agent.kind === 'critic' && agent.card;
    if (criticOnCard && state === 'done' && count(input.findings, 'the findings count') === null) {
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
    // a run that started on a card finishes on it. One that started with none, or on an implicit card (it made its own, ADR-27),
    // may name its card here, and nothing is said.
    if (card && agent.card && !isImplicitCard(agent.card) && card !== agent.card) {
      warn?.(`once-upon: --card ${card} is not the card ${name} started on (${agent.card})`);
    } else if (card && this.cards && !this.cardFacts(card)) {
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
    // git is the truth for what an author made (ADR-29): its worktree's HEAD and branch, when the card's worktree (else the run's
    // checkout) is a checkout on a branch. A typed commit that is HEAD or behind it stands; one that is not is replaced, with a
    // warning. Anything git cannot say (no checkout, gone, detached, slow), and every run that is not an author finishing done,
    // goes on with what was typed, as before
    if (state === 'done' && agent.kind === 'author' && !input.noCommit) {
      const dir = (agent.card && this.cardFacts(agent.card)?.worktree) || agent.cwd;
      const facts = dir ? worktreeFacts(dir) : null;
      const onItsBranch =
        isFeatureBranch(facts?.branch) && (!agent.branch || facts.branch === agent.branch);
      if (dir && facts && onItsBranch) {
        const typed = result.commit;
        if (typed && !isAncestor(dir, typed, facts.head)) {
          warn?.(
            `once-upon: --commit ${typed} is not in ${dir}'s history (HEAD ${facts.head}): recorded ${facts.head}`,
          );
        }
        // nothing typed: HEAD counts as made when it moved past the run's start tip and is not the default branch's own tip (a
        // branch with nothing over main: its HEAD is the commit it was cut from, which a null start tip must not mistake for work)
        const baseTip = [defaultBranchOf(dir), 'main', 'master']
          .map((name) => (name ? commitOf(dir, `refs/heads/${name}`) : null))
          .find(Boolean);
        const untouched = facts.head === agent.tip || facts.head === baseTip;
        if (typed ? !isAncestor(dir, typed, facts.head) : !untouched) {
          result.commit = facts.head;
        }
        if (result.commit && result.branch !== facts.branch) {
          result.branch = facts.branch;
        }
      }
    }
    // none given: what an author's registered branch gained since the run started. A run that failed or was stopped made
    // nothing to point at, and a helper, critic or researcher never takes an author's commit
    if (
      !Object.keys(result).length &&
      state === 'done' &&
      agent.kind === 'author' &&
      !input.noCommit
    ) {
      Object.assign(result, madeOnBranch(agent));
    }
    // an author done with no commit and changes left in its worktree: recorded once, here (a planner made none to hold)
    let uncommitted: true | null = null;
    const finishedAuthor = state === 'done' && agent.kind === 'author' && agent.state !== 'plan';
    if (finishedAuthor && !result.commit && !input.noCommit) {
      const dir = uncommittedWorktree(agent);
      if (dir) {
        uncommitted = true;
        warn?.(
          `once-upon: ${name} left uncommitted changes in ${dir}: commit them before the finish`,
        );
      }
    }
    input.beforeFinish?.(agent, result);
    return this.append({
      ...this.base('finish', name, agent.sid, input),
      run: agent.run ?? undefined,
      state,
      outcome: clean(input.outcome, 'the outcome') || null,
      result: Object.keys(result).length ? result : null,
      uncommitted,
      findings: count(input.findings, 'the findings count'),
      notes: clean(input.notes, 'the notes path', 500) || null,
    });
  }
}
