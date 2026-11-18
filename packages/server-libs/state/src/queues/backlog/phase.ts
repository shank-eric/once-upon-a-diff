/**
 * The card owns its runs (ADR-25). A run names its card when it starts (`agent start --card ID`, the `card` of its start
 * row in agents.jsonl), and everything about the card's work is read from the runs that name it: no claim to find the
 * run by, no name, no time window, no copy of the repo or branch typed on the run. The card's repo and branch are the
 * run's. `runsOf` is the card's runs, and `cardPhase` is the one table that turns them into the column.
 *
 * A run of an agent restarted under the same sid and name (a fix round) is a second run of the card, kept in the agent's
 * `earlier` (events.ts). A run whose `card` is unknown or dropped is nobody's: it is an agent card of its own (agent-home.ts).
 * A run with no `card` at all (a row from before ADR-25, a helper) is read by nothing here: the claim finds no run.
 * Pure: the board gathers the facts.
 */
import type { BoardColumn } from '@once-upon-a-diff/contracts/types';
import { isImplicitCard, sameRepo } from '@once-upon-a-diff/terms/ids';
import { STALE_MS, runIsOpen, staleAfterMs } from '../../records/agents/events.ts';
import { implicitCards } from '../../records/agents/implicit.ts';
import {
  isAcked,
  isCritic,
  isStoryteller,
  lastActivity,
  type LedgerAgent,
} from '../../records/agents/ledger.ts';
import { CLAIM_GRACE_HOURS, OPEN, agentKey } from './claims.ts';
import { UNKNOWN_READY, readyColumn, type ReadyFacts } from './ready.ts';
import type { BacklogItem } from './types.ts';

/** A started item whose work merged or landed, or whose agent finished, stays in Done this long. */
export const DONE_HOURS = 1;

/** A run that changes the card's phase: an author's or fixer's (kind author), or an old row with no kind. A researcher's, a helper's or a storyteller's does not: a lookup is not the work. */
export const isWorkRun = (run: Pick<LedgerAgent, 'kind'>): boolean =>
  !run.kind || run.kind === 'author';

/** One run's start time, for ordering (a run with none sorts first). */
const startedAt = (run: LedgerAgent): number => run.started?.getTime() ?? 0;

/**
 * Every run on the card, oldest first: the latest run of each agent and the runs before it, whose registered `card` is the
 * item's id. A run is as it stood when it ended, so a fix round's run is its own entry.
 */
export function runsOf(item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): LedgerAgent[] {
  return agents
    .flatMap((agent) => [...(agent.earlier ?? []), agent])
    .filter((run) => run.card === item.id)
    .sort((first, second) => startedAt(first) - startedAt(second));
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
}

/** The rows of the table `cardPhase` reads, one line each: the doc comment below and `once-upon card status` both say it from here. */
export const PHASE_ROWS = {
  '1': 'a work run is open: waiting (a question) is Waiting, parked on your story review is Ready, plan is Agent checks, running or fixing is Working',
  '2': 'a critic is open: Agent checks',
  '3': 'the latest work run failed (Error) or stopped (back in Backlog, tried)',
  '3b': 'a storyteller is running: Agent checks',
  '4': 'fixes are due: the latest critic finished with findings after the latest work run: Agent checks until a fix run opens',
  '5': 'built, and no critic has passed (none yet, or the latest failed, stopped or died), with no skip recorded: Waiting for your call (skip the critic or start one)',
  '6': 'built, with a branch: an open PR is PR open; pushed with no PR is Ready to ship; else Ready for your review (a repo whose settings say skips_review: Ready to ship)',
  '7': 'landed, or no branch: Done for the Done hour after the work ended, then off the board',
} as const;

export type PhaseRow = keyof typeof PHASE_ROWS;

const msOf = (date: Date | null | undefined): number | null => (date ? date.getTime() : null);

/**
 * The column of a card from its runs, first row that fits (ADR-25). `runs` is `runsOf(item, agents)`, oldest first.
 *
 *   1  a work run is open        waiting (a question) is Waiting, parked on your story review (`review`) is Ready; plan is Agent checks (the plan to check); running or fixing is
 *                                Working. A fix round is the card's run, so it is Working here whether or not it was told `fixing`
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
 *   7  landed, or no branch      Done for DONE_HOURS after the work ended, then null (off the board)
 *
 * A critic that finished done with no findings count (an old row) reads as a pass, as it always did; `agent finish` no
 * longer takes a carded critic's done without one. Null when the card is past its Done hour, or has nothing to say (no
 * work run and not started on a branch): the card keeps its own state, or shows pending on its claim.
 */
export function cardPhase(
  item: Pick<BacklogItem, 'state' | 'repo' | 'branch' | 'critic_skipped'> &
    Partial<Pick<BacklogItem, 'landed_at' | 'someday'>>,
  runs: LedgerAgent[],
  nowMs: number,
  ready: ReadyFacts = UNKNOWN_READY,
  skipsReview = false,
): CardPhase | null | undefined {
  const work = runs.filter(isWorkRun);
  const critics = runs.filter(isCritic);
  const latestWork = work[work.length - 1];
  const isOpen = (run: LedgerAgent) => OPEN.includes(run.state);
  const lastSign = (run: LedgerAgent) =>
    (run.lastEvent ?? run.started ?? new Date(nowMs)).getTime();
  const alive = (run: LedgerAgent) => isOpen(run) && nowMs - lastSign(run) <= staleAfterMs(run);
  const working = [...work].reverse().find(isOpen);
  if (working) {
    const when = msOf(working.ended);
    if (working.state === 'waiting') {
      return { column: working.review ? 'ready' : 'waiting', when, tried: false, row: '1' };
    }
    return {
      column: working.state === 'plan' ? 'checks' : 'working',
      when,
      tried: false,
      row: '1',
    };
  }
  if (critics.some(alive)) {
    return { column: 'checks', when: null, tried: false, row: '2' };
  }
  // a card you set aside (someday) after its failure is dealt with: it goes back to Backlog, as an acked one does
  if (latestWork?.state === 'failed' && !isAcked(latestWork) && !item.someday) {
    return { column: 'error', when: msOf(latestWork.ended), tried: false, row: '3' };
  }
  if (latestWork && (latestWork.state === 'failed' || latestWork.state === 'stopped')) {
    return { column: 'backlog', when: msOf(latestWork.ended), tried: true, row: '3' };
  }
  if (runs.some((run) => isStoryteller(run) && run.state === 'running' && alive(run))) {
    return { column: 'checks', when: null, tried: false, row: '3b' };
  }
  const built = item.state === 'started' && !!item.branch && !item.landed_at;
  if (!latestWork && !built && !item.landed_at) {
    return undefined;
  }
  const when = msOf(latestWork?.ended);
  const settledAt = (run: LedgerAgent) => msOf(run.ended ?? run.lastEvent ?? run.started) ?? 0;
  const latestCritic = [...critics].sort(
    (first, second) => settledAt(second) - settledAt(first),
  )[0];
  if (
    latestCritic?.state === 'done' &&
    (latestCritic.findings ?? 0) > 0 &&
    nowMs - (msOf(latestCritic.ended) ?? nowMs) <= STALE_MS &&
    (when ?? 0) <= (msOf(latestCritic.ended) ?? 0)
  ) {
    return { column: 'checks', when: msOf(latestCritic.ended), tried: false, row: '4' };
  }
  if (built && (!latestCritic || latestCritic.state !== 'done') && !item.critic_skipped) {
    return { column: 'waiting', when, tried: false, row: '5' };
  }
  if (built) {
    return {
      column: readyColumn(ready, skipsReview),
      when,
      tried: false,
      row: '6',
    };
  }
  return when !== null && nowMs - when > DONE_HOURS * 3600 * 1000
    ? null
    : { column: 'done', when, tried: false, row: '7' };
}

/**
 * The joins between runs and cards that do not hold, one line each, for `once-upon doctor` (read only: nothing is fixed here):
 * a run naming a card that is not there or was dropped, a run whose typed repo or branch is not its card's (the card's is
 * the one the board reads), a finish naming another card than its start, a run still open with no sign of life for STALE_MS,
 * and a card with two open author runs at once (a restart of one agent is a fix round, not a second).
 */
export function cardRunProblems(
  items: BacklogItem[],
  agents: LedgerAgent[],
  nowMs: number,
): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const problems: string[] = [];
  const runs = agents.flatMap((agent) => [...(agent.earlier ?? []), agent]);
  for (const run of runs) {
    const label = `${agentKey(run)}${run.run ? ` ${run.run}` : ''}`;
    const item = run.card ? byId.get(run.card) : undefined;
    // an implicit card (ADR-27) is its runs: no backlog item holds it until it is adopted
    if (run.card && !item && isImplicitCard(run.card)) {
      continue;
    }
    if (run.card && (!item || item.state === 'dropped')) {
      problems.push(`${label} names ${run.card}, which ${item ? 'was dropped' : 'is not a card'}`);
      continue;
    }
    if (!item) {
      continue;
    }
    if (run.repo && item.repo && !sameRepo(run.repo, item.repo)) {
      problems.push(`${label} typed repo ${run.repo}, its card ${item.id} is on ${item.repo}`);
    }
    // only an open run follows a rename (`backlog branch` moves those): a finished run's branch is the one it worked on
    if (OPEN.includes(run.state) && run.branch && item.branch && run.branch !== item.branch) {
      problems.push(
        `${label} typed branch ${run.branch}, its card ${item.id} is on ${item.branch}`,
      );
    }
    if (run.result?.card && run.result.card !== run.card) {
      problems.push(`${label} finished naming ${run.result.card}, but it started on ${run.card}`);
    }
  }
  for (const agent of agents) {
    const sign = (agent.lastEvent ?? agent.started)?.getTime() ?? nowMs;
    if (OPEN.includes(agent.state) && nowMs - sign > STALE_MS) {
      problems.push(`${agentKey(agent)} is open and silent for over 24 hours`);
    }
  }
  for (const item of items) {
    const open = agents.filter(
      (agent) => agent.card === item.id && agent.kind === 'author' && OPEN.includes(agent.state),
    );
    if (open.length > 1) {
      problems.push(
        `${item.id} has ${open.length} open author runs (${open.map(agentKey).join(', ')})`,
      );
    }
  }
  return problems;
}

/**
 * The cards past the backlog that carry no branch, one line each, for `once-upon doctor`: the board joins a card to its
 * worktree, PR and story by the card's branch, so a card an agent holds with none is joined to nothing. A started card
 * always has one (a start names it), so this finds a card claimed for longer than CLAIM_GRACE_HOURS that is still open with
 * none: an agent that took it and never registered a branch. An open, someday or landed card is exempt; so is a fresh
 * claim, whose author has not made its branch yet.
 */
export function cardBranchProblems(items: BacklogItem[], nowMs: number): string[] {
  const problems: string[] = [];
  for (const item of items) {
    if (item.state === 'dropped' || item.landed_at || item.someday || item.branch) {
      continue;
    }
    const since = item.claim ? Date.parse(item.claim.at) : Number.NaN;
    if (
      item.state === 'started' ||
      (item.claim && !Number.isNaN(since) && nowMs - since > CLAIM_GRACE_HOURS * 3600 * 1000)
    ) {
      problems.push(
        `${item.id} has no branch (${item.state === 'started' ? 'started' : `claimed by ${item.claim?.agent}`}): backlog branch ${item.id} <branch>`,
      );
    }
  }
  return problems;
}

/**
 * The duplicates a join at write time would have prevented, one per pair, for `once-upon doctor`: a backlog card with a branch and
 * no run, no claim and no drop, and an implicit card with a run on its repo and branch that was live when the backlog card was
 * added (a run open, or the card added no later than the last run's activity). A card added after that work ended, on a branch
 * name it reused, is its own. Each carries the `backlog drop ID --into CARD` that merges the pair; nothing is merged here.
 */
export function duplicateCardProblems(items: BacklogItem[], agents: LedgerAgent[]): string[] {
  const taken = new Set<string>();
  const problems: string[] = [];
  const twins = items.filter(
    (item) =>
      item.state !== 'dropped' &&
      !!item.branch &&
      !item.landed_at &&
      !item.claim &&
      !item.someday &&
      runsOf(item, agents).length === 0,
  );
  for (const card of implicitCards(agents)) {
    if (items.some((item) => item.id === card.id)) {
      continue;
    }
    const open = card.runs.some(runIsOpen);
    const lastEnd = Math.max(...card.runs.map((run) => lastActivity(run)?.getTime() ?? 0));
    const twin = twins.find(
      (item) =>
        !taken.has(item.id) &&
        (open || Date.parse(item.added_at) <= lastEnd) &&
        card.runs.some(
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
