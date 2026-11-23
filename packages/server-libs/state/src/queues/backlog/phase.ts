/**
 * The card owns its runs (ADR-25). A run names its card when it starts (`agent start --card ID`, the `card` of its start
 * row in agents.jsonl), and everything about the card's work is read from the runs that name it: no name, no time window, no copy of the repo or branch typed on the run. The card's repo and branch are the
 * run's. `runsOf` is the card's runs, and `cardPhase` is the one table that turns them into the column.
 *
 * A run of an agent restarted under the same sid and name (a fix round) is a second run of the card, kept in the agent's
 * `earlier` (events.ts). A run whose `card` is unknown or dropped is nobody's: it is an agent card of its own (agent-home.ts).
 * A run with no `card` at all (a row from before ADR-25, a helper) is read by nothing here.
 * Pure: the board gathers the facts.
 */
import type { BoardColumn } from '@once-upon-a-diff/contracts/types';
import { sameRepo } from '@once-upon-a-diff/terms/ids';
import { STALE_MS, runIsOpen, staleAfterMs } from '../../records/agents/events.ts';
import {
  isAcked,
  isCritic,
  isStoryteller,
  lastActivity,
  type LedgerAgent,
} from '../../records/agents/ledger.ts';
import { OPEN, agentKey } from './claims.ts';
import { UNKNOWN_READY, readyColumn, type ReadyFacts } from './ready.ts';
import type { BacklogItem } from './types.ts';

/** A started item whose work merged or landed, or whose agent finished, stays in Done this long. */
export const DONE_HOURS = 1;

/** A run that changes the card's phase: an author's or fixer's (kind author), or an old row with no kind. A researcher's, a helper's or a storyteller's does not: a lookup is not the work. */
export const isWorkRun = (run: Pick<LedgerAgent, 'kind'>): boolean =>
  !run.kind || run.kind === 'author';

/** One run's start time, for ordering (a run with none sorts first). */
const startedAt = (run: LedgerAgent): number => run.started?.getTime() ?? 0;

/** The runs of each card in one agents list, oldest first (built once per list: a build asks for every card). */
const runsByCard = new WeakMap<
  LedgerAgent[],
  { size: number; byCard: Map<string, LedgerAgent[]> }
>();

function runIndex(agents: LedgerAgent[]): Map<string, LedgerAgent[]> {
  const kept = runsByCard.get(agents);
  if (kept && kept.size === agents.length) {
    return kept.byCard;
  }
  const byCard = new Map<string, LedgerAgent[]>();
  for (const run of agents.flatMap((agent) => [...(agent.earlier ?? []), agent])) {
    if (run.card) {
      const runs = byCard.get(run.card) ?? [];
      runs.push(run);
      byCard.set(run.card, runs);
    }
  }
  for (const runs of byCard.values()) {
    runs.sort((first, second) => startedAt(first) - startedAt(second));
  }
  runsByCard.set(agents, { size: agents.length, byCard });
  return byCard;
}

/**
 * Every run on the card, oldest first: the latest run of each agent and the runs before it, whose registered `card` is the
 * item's id. A run is as it stood when it ended, so a fix round's run is its own entry.
 */
export function runsOf(item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): LedgerAgent[] {
  return [...(runIndex(agents).get(item.id) ?? [])];
}

/** Every run of the repo's branch, whatever card it names, oldest first: what covers a branch that has moved (`coveringRun`). */
export function runsOnBranch(agents: LedgerAgent[], repo: string, branch: string): LedgerAgent[] {
  return agents
    .flatMap((agent) => [...(agent.earlier ?? []), agent])
    .filter(
      (run) =>
        !!run.repo && sameRepo(run.repo, repo) && (run.result?.branch ?? run.branch) === branch,
    )
    .sort((first, second) => startedAt(first) - startedAt(second));
}

/**
 * The work run that accounts for a branch tip: one still going (running, at a plan or fixing, with a sign of life inside its
 * stale time; a parked or waiting one does not), or one that finished done with a commit that is the tip (a short sha counts
 * either way round). Null means the branch moved outside every run. The board's three "moved" rules and `recordFix` ask this
 * one question.
 */
export function coveringRun(runs: LedgerAgent[], tip: string, nowMs: number): LedgerAgent | null {
  const head = tip.toLowerCase();
  const covers = (run: LedgerAgent): boolean => {
    if (run.state === 'running' || run.state === 'plan' || run.state === 'fixing') {
      return nowMs - (lastActivity(run)?.getTime() ?? nowMs) <= staleAfterMs(run);
    }
    const commit = run.result?.commit?.toLowerCase() ?? '';
    return (
      run.state === 'done' &&
      commit.length >= 7 &&
      (head.startsWith(commit) || commit.startsWith(head))
    );
  };
  return [...runs].reverse().find((run) => isWorkRun(run) && covers(run)) ?? null;
}

/**
 * Why dropping the card would leave a live run on no card, or null when it would not: a run of the card (the latest of an agent
 * or one before it) that is still open is stranded, so the drop says to move it first (`backlog drop ID --into CARD`). Runs
 * that are all over strand nothing live (the board hides them with the dropped card), so such a card, an implicit one too,
 * drops bare.
 */
export function dropRunsProblem(
  item: Pick<BacklogItem, 'id'>,
  agents: LedgerAgent[],
): string | null {
  const open = runsOf(item, agents).filter(runIsOpen);
  if (!open.length) {
    return null;
  }
  const names = [...new Set(open.map((run) => run.name))].join(', ');
  return `${item.id} has ${open.length} open run${open.length === 1 ? '' : 's'} (${names}): dropping it would leave them on no card. Move them first: once-upon backlog drop ${item.id} --into CARD`;
}

/** The latest run of each agent on the card (a fix round replaces its author's first run), as it stood, oldest first: what the card shows. */
export function agentsOnCard(item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): LedgerAgent[] {
  const latest = new Map<string, LedgerAgent>();
  for (const run of runsOf(item, agents)) {
    latest.set(agentKey(run), run);
  }
  return [...latest.values()];
}

/**
 * Whether a work run names the card: then the card is read by its runs (`cardPhase`). A card no work run names is a started
 * or pending card, not a phase: a critic, a helper or a researcher alone does not say where the card is.
 */
export const namedByRuns = (item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): boolean =>
  runsOf(item, agents).some(isWorkRun);

/** The agent whose run drives the card's column, as that run stood: the latest work run on the card, or null when none names it. */
export function workAgent(
  item: Pick<BacklogItem, 'id'>,
  agents: LedgerAgent[],
): LedgerAgent | null {
  const work = runsOf(item, agents).filter(isWorkRun);
  return work.length ? work[work.length - 1] : null;
}

/** The keys of the agents whose latest run names a card that exists and is not dropped: the card shows them, so they have no card of their own. */
export function carriedKeys(items: BacklogItem[], agents: LedgerAgent[]): Set<string> {
  const live = new Set(items.filter((item) => item.state !== 'dropped').map((item) => item.id));
  return new Set(
    agents.filter((agent) => agent.card && live.has(agent.card)).map((agent) => agentKey(agent)),
  );
}

/** Where a card with runs goes. `when` is the latest time that decided it (for the card's "since"); `tried` marks a card sent back to Backlog. */
export interface CardPhase {
  column: BoardColumn;
  when: number | null;
  tried: boolean;
  /** the key into PHASE_ROWS of the row that decided it: `once-upon card status` prints it */
  row: PhaseRow;
  /** row 6 only: Working because the branch moved past the run's commit, with no run behind the tip (the card says "changed outside a run") */
  outside?: { tip: string; path: string };
}

/** The rows of the table `cardPhase` reads, one line each: the doc comment below and `once-upon card status` both say it from here. */
export const PHASE_ROWS = {
  '1': 'a work run is open: waiting (a question) is Waiting, parked on your story review is Ready, plan is Agent checks, running or fixing is Working',
  '1b': 'parked after its last run: a reopen, hold or someday newer than every run on the card (a beat included) is Backlog; a new run after it ends this',
  '2': 'a critic is open: Agent checks',
  '3': 'the latest work run failed (Error) or stopped (back in Backlog, tried)',
  '3b': 'a storyteller is running: Agent checks',
  '4': 'fixes are due: the latest critic finished with findings after the latest work run: Agent checks until a fix run opens',
  '5': 'built, and no critic has passed (none yet, or the latest failed, stopped or died), with no skip recorded: Waiting for your call (skip the critic or start one)',
  '6': 'built, with a branch: an open PR is PR open; pushed with no PR is Ready to ship; else Ready for your review, or Working when the board sees the branch moved past the commit its run finished at (a repo whose settings say skips_review: Ready to ship)',
  '7': 'no branch, or landed (`backlog done`): Done for the Done hour after the work ended or landed, then off the board',
} as const;

export type PhaseRow = keyof typeof PHASE_ROWS;

const msOf = (date: Date | null | undefined): number | null => (date ? date.getTime() : null);

/**
 * The column of a card from its runs, first row that fits (ADR-25). `runs` is `runsOf(item, agents)`, oldest first.
 *
 *   1  a work run is open        waiting (a question) is Waiting, parked on your story review (`review`) is Ready; plan is Agent checks (the plan to check); running or fixing is
 *                                Working. A fix round is the card's run, so it is Working here whether or not it was told `fixing`
 *   1b parked after its runs     a reopen, a hold or a someday (`parked_at`) newer than the last sign of every run on the card: back in Backlog,
 *                                whatever its runs or story say, until a run, a beat or a rebuilt story comes after the park. Read after row 1
 *                                (an open work run) and the landed arm, before the critic, failure and built rows
 *   2  a critic is open          Agent checks, in every repo (an open critic with no sign of life for STALE_MS is dead and holds nothing)
 *   3  the latest work run       failed: Error (until `agent ack` clears it or the card is set aside as someday, then as stopped); stopped: back in Backlog, tried
 *   3b a storyteller is open     running with a sign of life in the last hour: Agent checks, in every repo (a failed build is read first; a waiting one, with a question, holds nothing)
 *   4  fixes are due             the latest critic finished with findings above 0, after the latest work run
 *                                ended (and under STALE_MS ago: findings nobody fixed lapse): Agent checks until a fix run opens (row 1)
 *   5  built, no critic passed   no critic yet, or the latest failed, was stopped or died, and the card's critic is not skipped
 *                                (`backlog skip-critic`): Waiting, for Eric's call to skip the critic or start one. A card that
 *                                is not built (landed, or no branch) never waits here: it is row 7
 *   6  built                     With a branch: an open PR is PR open; pushed with no PR is Ready to ship (ready.ts); else Ready for
 *                                your review. A repo whose settings say skips_review (`skipsReview`): Ready to ship. Facts not known
 *                                yet keep Ready for your review
 *   7  no branch, or landed      Done for DONE_HOURS after the work ended (a landed card: after it landed), then null (off the board).
 *                                A landed card (`backlog done`) leaves the review columns whatever its runs or story say, so it is
 *                                read right after row 1 (an open work run), before the critic and storyteller holds and the built rows
 *
 * A critic that finished done with no findings count (an old row) reads as a pass, as it always did; `agent finish` no
 * longer takes a carded critic's done without one. Null when the card is past its Done hour, or has nothing to say (no
 * work run and not started on a branch): the card keeps its own state.
 */
export function cardPhase(
  item: Pick<BacklogItem, 'state' | 'repo' | 'branch' | 'critic_skipped'> &
    Partial<Pick<BacklogItem, 'landed_at' | 'someday' | 'parked_at'>>,
  runs: LedgerAgent[],
  nowMs: number,
  ready: ReadyFacts = UNKNOWN_READY,
  skipsReview = false,
): CardPhase | null | undefined {
  const facts = phaseFacts(item, runs, nowMs, ready, skipsReview);
  for (const rule of PHASE_RULES) {
    const verdict = rule(facts);
    if (verdict !== NEXT_ROW) {
      return verdict;
    }
  }
  return undefined;
}

/** What the rows read of a card: its runs, how old they are and whether it is built. */
interface PhaseFacts {
  item: Pick<BacklogItem, 'state' | 'repo' | 'branch' | 'critic_skipped'> &
    Partial<Pick<BacklogItem, 'landed_at' | 'someday' | 'parked_at'>>;
  runs: LedgerAgent[];
  nowMs: number;
  ready: ReadyFacts;
  skipsReview: boolean;
  critics: LedgerAgent[];
  latestWork: LedgerAgent | undefined;
  latestCritic: LedgerAgent | undefined;
  /** started on a branch */
  built: boolean;
  /** when the latest work run ended */
  when: number | null;
  /** open, and heard from within its kind's stale limit */
  alive: (run: LedgerAgent) => boolean;
}

/** A row's verdict: the card's phase, null (off the board), undefined (nothing to say), or NEXT_ROW (this row does not fit). */
const NEXT_ROW = Symbol('next row');
type PhaseVerdict = CardPhase | null | undefined | typeof NEXT_ROW;

const isOpenRun = (run: LedgerAgent) => OPEN.includes(run.state);

function phaseFacts(
  item: PhaseFacts['item'],
  runs: LedgerAgent[],
  nowMs: number,
  ready: ReadyFacts,
  skipsReview: boolean,
): PhaseFacts {
  const critics = runs.filter(isCritic);
  const latestWork = runs.filter(isWorkRun).pop();
  const lastSign = (run: LedgerAgent) =>
    (run.lastEvent ?? run.started ?? new Date(nowMs)).getTime();
  const settledAt = (run: LedgerAgent) => msOf(run.ended ?? run.lastEvent ?? run.started) ?? 0;
  return {
    item,
    runs,
    nowMs,
    ready,
    skipsReview,
    critics,
    latestWork,
    latestCritic: [...critics].sort((first, second) => settledAt(second) - settledAt(first))[0],
    built: item.state === 'started' && !!item.branch,
    when: msOf(latestWork?.ended),
    alive: (run) => isOpenRun(run) && nowMs - lastSign(run) <= staleAfterMs(run),
  };
}

const phaseOf = (
  column: BoardColumn,
  row: PhaseRow,
  when: number | null,
  tried = false,
): CardPhase => ({ column, when, tried, row });

const tooOld = (when: number | null, nowMs: number) =>
  when !== null && nowMs - when > DONE_HOURS * 3600 * 1000;

/** Row 1: a work run is open. */
function rowOpenWork({ runs }: PhaseFacts): PhaseVerdict {
  const working = runs.filter(isWorkRun).reverse().find(isOpenRun);
  if (!working) {
    return NEXT_ROW;
  }
  const when = msOf(working.ended);
  if (working.state === 'waiting') {
    return phaseOf(working.review ? 'ready' : 'waiting', '1', when);
  }
  return phaseOf(working.state === 'plan' ? 'checks' : 'working', '1', when);
}

/** Row 7, landed: Done for DONE_HOURS after it landed, whatever its runs say. */
function rowLanded({ item, nowMs }: PhaseFacts): PhaseVerdict {
  const landedMs = item.landed_at ? Date.parse(item.landed_at) : NaN;
  if (Number.isNaN(landedMs)) {
    return NEXT_ROW;
  }
  return tooOld(landedMs, nowMs) ? null : phaseOf('done', '7', landedMs);
}

/** Row 1b: parked (a reopen, hold or someday) after every run on the card, a beat included: back in Backlog. */
function rowParked({ item, runs, latestWork }: PhaseFacts): PhaseVerdict {
  const parkedMs = item.parked_at ? Date.parse(item.parked_at) : NaN;
  if (
    Number.isNaN(parkedMs) ||
    !latestWork ||
    // a live run of any kind (a critic, a storyteller, a helper) keeps the card on the board with its agents
    runs.some(isOpenRun) ||
    !runs.every((run) => parkedMs > (lastActivity(run)?.getTime() ?? 0))
  ) {
    return NEXT_ROW;
  }
  // a parked card whose last work run failed or was stopped stays marked tried, as row 3 marks it
  const tried = latestWork.state === 'failed' || latestWork.state === 'stopped';
  return phaseOf('backlog', '1b', parkedMs, tried);
}

/** Row 2: a critic is open. */
function rowOpenCritic({ critics, alive }: PhaseFacts): PhaseVerdict {
  return critics.some(alive) ? phaseOf('checks', '2', null) : NEXT_ROW;
}

/** Row 3: the latest work run failed or stopped. */
function rowFailed({ item, latestWork }: PhaseFacts): PhaseVerdict {
  // a card you set aside (someday) after its failure is dealt with: it goes back to Backlog, as an acked one does
  if (latestWork?.state === 'failed' && !isAcked(latestWork) && !item.someday) {
    return phaseOf('error', '3', msOf(latestWork.ended));
  }
  if (latestWork && (latestWork.state === 'failed' || latestWork.state === 'stopped')) {
    return phaseOf('backlog', '3', msOf(latestWork.ended), true);
  }
  return NEXT_ROW;
}

/** Row 3b: a storyteller is running. */
function rowStoryteller({ runs, alive }: PhaseFacts): PhaseVerdict {
  const telling = runs.some((run) => isStoryteller(run) && run.state === 'running' && alive(run));
  return telling ? phaseOf('checks', '3b', null) : NEXT_ROW;
}

/** No work run and not started on a branch: nothing to say. */
function rowNothing({ latestWork, built }: PhaseFacts): PhaseVerdict {
  return !latestWork && !built ? undefined : NEXT_ROW;
}

/** Row 4: fixes are due. */
function rowFixesDue({ latestCritic, when, nowMs }: PhaseFacts): PhaseVerdict {
  const due =
    latestCritic?.state === 'done' &&
    (latestCritic.findings ?? 0) > 0 &&
    nowMs - (msOf(latestCritic.ended) ?? nowMs) <= STALE_MS &&
    (when ?? 0) <= (msOf(latestCritic.ended) ?? 0);
  return due ? phaseOf('checks', '4', msOf(latestCritic.ended)) : NEXT_ROW;
}

/** Row 5: built, and no critic has passed. */
function rowNoCritic({ built, latestCritic, item, when }: PhaseFacts): PhaseVerdict {
  const unchecked = !latestCritic || latestCritic.state !== 'done';
  return built && unchecked && !item.critic_skipped ? phaseOf('waiting', '5', when) : NEXT_ROW;
}

/** Row 6: built. */
function rowBuilt({ built, ready, skipsReview, when }: PhaseFacts): PhaseVerdict {
  if (!built) {
    return NEXT_ROW;
  }
  const column = readyColumn(ready, skipsReview);
  return {
    ...phaseOf(column, '6', when),
    ...(column === 'working' && ready.moved ? { outside: ready.moved } : {}),
  };
}

/** Row 7: no branch: Done for DONE_HOURS after the work ended. */
function rowDone({ when, nowMs }: PhaseFacts): PhaseVerdict {
  return tooOld(when, nowMs) ? null : phaseOf('done', '7', when);
}

/** The rows in order: the first that fits decides. */
const PHASE_RULES: ((facts: PhaseFacts) => PhaseVerdict)[] = [
  rowOpenWork,
  rowLanded,
  rowParked,
  rowOpenCritic,
  rowFailed,
  rowStoryteller,
  rowNothing,
  rowFixesDue,
  rowNoCritic,
  rowBuilt,
  rowDone,
];

/**
 * The joins between runs and cards that do not hold, one line each, for `once-upon doctor` (read only: nothing is fixed here):
 * a run naming a card that is not there or was dropped, a run whose typed repo or branch is not its card's (the card's is
 * the one the board reads), a finish naming another card than its start, a run still open with no sign of life for STALE_MS,
 * and a card with two open author runs at once (a restart of one agent is a fix round, not a second). `known` is the ids of every
 * stored card (`items` are the listed ones, which the other checks are about): a run on a stored card an agent, a session, a PR or a
 * story made is on a card, and is checked no further, as a run on an implicit card is.
 */
export function cardRunProblems(
  items: BacklogItem[],
  agents: LedgerAgent[],
  nowMs: number,
  known: ReadonlySet<string> = new Set(items.map((item) => item.id)),
): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const runs = agents.flatMap((agent) => [...(agent.earlier ?? []), agent]);
  return [
    ...runs.flatMap((run) =>
      runJoinProblems(run, run.card ? byId.get(run.card) : undefined, known),
    ),
    ...agents.flatMap((agent) => silentProblems(agent, nowMs)),
    ...items.flatMap((item) => twoAuthorProblems(item, agents)),
  ];
}

/** The joins of one run to its card that do not hold: a missing or dropped card, a typed repo or branch that is not the card's, a finish naming another card. */
function runJoinProblems(
  run: LedgerAgent,
  item: BacklogItem | undefined,
  known: ReadonlySet<string>,
): string[] {
  const label = `${agentKey(run)}${run.run ? ` ${run.run}` : ''}`;
  if (run.card && !item && known.has(run.card)) {
    return [];
  }
  if (run.card && (!item || item.state === 'dropped')) {
    return [`${label} names ${run.card}, which ${item ? 'was dropped' : 'is not a card'}`];
  }
  if (!item) {
    return [];
  }
  const problems: string[] = [];
  if (run.repo && item.repo && !sameRepo(run.repo, item.repo)) {
    problems.push(`${label} typed repo ${run.repo}, its card ${item.id} is on ${item.repo}`);
  }
  // only an open run follows a rename (`backlog branch` moves those): a finished run's branch is the one it worked on
  if (OPEN.includes(run.state) && run.branch && item.branch && run.branch !== item.branch) {
    problems.push(`${label} typed branch ${run.branch}, its card ${item.id} is on ${item.branch}`);
  }
  if (run.result?.card && run.result.card !== run.card) {
    problems.push(`${label} finished naming ${run.result.card}, but it started on ${run.card}`);
  }
  return problems;
}

/** Whether a card is being worked: started, or a work run on it is open. */
const isWorked = (item: BacklogItem, agents: LedgerAgent[]): boolean => {
  const run = workAgent(item, agents);
  return item.state === 'started' || (!!run && runIsOpen(run));
};

/** A run still open with no sign of life for STALE_MS. */
function silentProblems(agent: LedgerAgent, nowMs: number): string[] {
  const sign = (agent.lastEvent ?? agent.started)?.getTime() ?? nowMs;
  return OPEN.includes(agent.state) && nowMs - sign > STALE_MS
    ? [`${agentKey(agent)} is open and silent for over 24 hours`]
    : [];
}

/** A card with two open author runs at once. */
function twoAuthorProblems(item: BacklogItem, agents: LedgerAgent[]): string[] {
  const open = agents.filter(
    (agent) => agent.card === item.id && agent.kind === 'author' && OPEN.includes(agent.state),
  );
  return open.length > 1
    ? [`${item.id} has ${open.length} open author runs (${open.map(agentKey).join(', ')})`]
    : [];
}

/**
 * The cards being worked that carry no branch, one line each, for `once-upon doctor`: the board joins a card to its worktree,
 * PR and story by the card's branch, so a card with none is joined to nothing. A dispatch always names a branch, so this is an
 * old row, or a run started on a branchless card with no `--branch`. A dropped, someday or landed card is exempt.
 */
export function cardBranchProblems(items: BacklogItem[], agents: LedgerAgent[] = []): string[] {
  return items
    .filter(
      (item) =>
        item.state !== 'dropped' &&
        !item.landed_at &&
        !item.someday &&
        !item.branch &&
        isWorked(item, agents),
    )
    .map((item) => `${item.id} has no branch (worked): backlog branch ${item.id} <branch>`);
}

/**
 * The duplicates a join at write time would have prevented, one per pair, for `once-upon doctor`: a backlog card with a branch and
 * no run and no drop, and a stored agent card (an `ic_` one, or any a run made) with a run on its repo and branch that was live when the backlog card was
 * added (a run open, or the card added no later than the last run's activity). A card added after that work ended, on a branch
 * name it reused, is its own. Each carries the `backlog drop ID --into CARD` that merges the pair; nothing is merged here.
 */
export function duplicateCardProblems(
  items: BacklogItem[],
  agents: LedgerAgent[],
  stored: BacklogItem[] = items,
): string[] {
  const taken = new Set<string>();
  const problems: string[] = [];
  const twins = items.filter(
    (item) =>
      item.state !== 'dropped' &&
      !!item.branch &&
      !item.landed_at &&
      !item.someday &&
      runsOf(item, agents).length === 0,
  );
  for (const card of stored) {
    const listed = (card.source ?? 'backlog') === 'backlog';
    const runs = listed || card.state === 'dropped' ? [] : runsOf(card, agents);
    if (!runs.length) {
      continue;
    }
    const open = runs.some(runIsOpen);
    const lastEnd = Math.max(...runs.map((run) => lastActivity(run)?.getTime() ?? 0));
    const twin = twins.find(
      (item) =>
        !taken.has(item.id) &&
        (open || Date.parse(item.added_at) <= lastEnd) &&
        runs.some(
          (run) =>
            (run.result?.branch ?? run.branch) === item.branch &&
            (item.repo ? sameRepo(run.repo, item.repo) : !run.repo),
        ),
    );
    if (twin) {
      taken.add(twin.id);
      problems.push(
        `${twin.id} and ${card.id} are one piece of work on ${twin.branch}: once-upon backlog drop ${twin.id} --into ${card.id}`,
      );
    }
  }
  return problems;
}
