/**
 * The card owns its runs (ADR-25). A run names its card when it starts (`agent start --card ID`, the `card` of its start
 * row in agents.jsonl), and everything about the card's work is read from the runs that name it: no claim to find the
 * run by, no name, no time window, no copy of the repo or branch typed on the run. The card's repo and branch are the
 * run's. `runsOf` is the card's runs, and `cardPhase` is the one table that turns them into the column.
 *
 * A run of an agent restarted under the same sid and name (a fix round) is a second run of the card, kept in the agent's
 * `earlier` (events.ts). A run whose `card` is unknown or dropped is nobody's: it keeps the old placement (agent-home.ts).
 * Runs with no `card` at all, from before this, are read by the old rules in claims.ts until the flip deletes them.
 * Pure: the board gathers the facts.
 */
import type { BoardColumn } from '@once-upon-a-diff/contracts/types';
import { repoName } from '@once-upon-a-diff/domain/text';
import { STALE_MS } from '../../records/agents/events.ts';
import { isCritic, type LedgerAgent } from '../../records/agents/ledger.ts';
import { OPEN, agentKey, claimedAgent } from './claims.ts';
import type { BacklogItem } from './types.ts';

/** A started item whose work merged or landed, or whose agent finished, stays in Done this long. */
export const DONE_HOURS = 1;

/** The repos whose finished work skips review for now and is Ready to ship (once-upon-a-diff and Larmor). */
export const SKIPS_REVIEW = /^(once-upon-a-diff|larmor)$/i;

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

/** The latest run of each agent on the card (a fix round replaces its author's first run), as it stood, oldest first: what the card shows. */
export function agentsOnCard(item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): LedgerAgent[] {
  const latest = new Map<string, LedgerAgent>();
  for (const run of runsOf(item, agents)) {
    latest.set(agentKey(run), run);
  }
  return [...latest.values()];
}

/**
 * Whether a work run names the card: then the card is read by its runs (`cardPhase`), and never by its claim. A card that
 * only critics, helpers or researchers name is still read by its claim: its author is an old cardless run (claims.ts).
 */
export const namedByRuns = (item: Pick<BacklogItem, 'id'>, agents: LedgerAgent[]): boolean =>
  runsOf(item, agents).some(isWorkRun);

/**
 * The agent whose run drives the card's column, as that run stood: the latest work run on the card, or, when no work run
 * names the card, the old claim's (claims.ts).
 */
export function workAgent(item: BacklogItem, agents: LedgerAgent[]): LedgerAgent | null {
  const work = runsOf(item, agents).filter(isWorkRun);
  return work.length ? work[work.length - 1] : claimedAgent(item, agents);
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
}

const msOf = (date: Date | null | undefined): number | null => (date ? date.getTime() : null);

/**
 * The column of a card from its runs, first row that fits (ADR-25). `runs` is `runsOf(item, agents)`, oldest first.
 *
 *   1  a work run is open        waiting (a question) is Waiting; plan is Agent checks (the plan to check); running or fixing is
 *                                Working. A fix round is the card's run, so it is Working here whether or not it was told `fixing`
 *   2  a critic is open          skip-review repos only: Agent checks (an open critic with no sign of life for STALE_MS is dead and holds nothing)
 *   3  the latest work run       failed or stopped: back in Backlog, tried
 *   4  fixes are due             skip-review repos only: the latest critic finished with findings above 0, after the latest work run
 *                                ended (and under STALE_MS ago: findings nobody fixed lapse): Agent checks until a fix run opens (row 1).
 *                                Elsewhere findings are the story's fix-before-push comments and hold nothing
 *   5  skip-review repo, no pass no critic yet, or the latest failed, was stopped or died: Agent checks
 *   6  built                     skip-review repo: Ready to ship. Other repos with a branch: Ready for your review
 *   7  no branch                 Done for DONE_HOURS after the work ended, then null (off the board)
 *
 * A critic that finished done with no findings count (an old row) reads as a pass, as it always did; `agent finish` no
 * longer takes a carded critic's done without one. Null when the card is past its Done hour, or has nothing to say (no
 * work run and not started on a branch): the caller falls back to the claim.
 */
export function cardPhase(
  item: Pick<BacklogItem, 'state' | 'repo' | 'branch'>,
  runs: LedgerAgent[],
  nowMs: number,
): CardPhase | null | undefined {
  const work = runs.filter(isWorkRun);
  const critics = runs.filter(isCritic);
  const latestWork = work[work.length - 1];
  const isOpen = (run: LedgerAgent) => OPEN.includes(run.state);
  const lastSign = (run: LedgerAgent) =>
    (run.lastEvent ?? run.started ?? new Date(nowMs)).getTime();
  const alive = (run: LedgerAgent) => isOpen(run) && nowMs - lastSign(run) <= STALE_MS;
  const working = [...work].reverse().find(isOpen);
  if (working) {
    const when = msOf(working.ended);
    if (working.state === 'waiting') {
      return { column: 'waiting', when, tried: false };
    }
    return {
      column: working.state === 'plan' ? 'checks' : 'working',
      when,
      tried: false,
    };
  }
  const skips = SKIPS_REVIEW.test(repoName(item.repo));
  if (skips && critics.some(alive)) {
    return { column: 'checks', when: null, tried: false };
  }
  if (latestWork && (latestWork.state === 'failed' || latestWork.state === 'stopped')) {
    return { column: 'backlog', when: msOf(latestWork.ended), tried: true };
  }
  const built = item.state === 'started' && !!item.branch;
  if (!latestWork && !built) {
    return undefined;
  }
  const when = msOf(latestWork?.ended);
  const settledAt = (run: LedgerAgent) => msOf(run.ended ?? run.lastEvent ?? run.started) ?? 0;
  const latestCritic = [...critics].sort(
    (first, second) => settledAt(second) - settledAt(first),
  )[0];
  if (
    skips &&
    latestCritic?.state === 'done' &&
    (latestCritic.findings ?? 0) > 0 &&
    nowMs - (msOf(latestCritic.ended) ?? nowMs) <= STALE_MS &&
    (when ?? 0) <= (msOf(latestCritic.ended) ?? 0)
  ) {
    return { column: 'checks', when: msOf(latestCritic.ended), tried: false };
  }
  if (skips && (!latestCritic || latestCritic.state !== 'done')) {
    return { column: 'checks', when, tried: false };
  }
  if (built) {
    return { column: skips ? 'ship' : 'ready', when, tried: false };
  }
  return when !== null && nowMs - when > DONE_HOURS * 3600 * 1000
    ? null
    : { column: 'done', when, tried: false };
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
    if (run.card && (!item || item.state === 'dropped')) {
      problems.push(`${label} names ${run.card}, which ${item ? 'was dropped' : 'is not a card'}`);
      continue;
    }
    if (!item) {
      continue;
    }
    if (run.repo && item.repo && run.repo.toLowerCase() !== item.repo.toLowerCase()) {
      problems.push(`${label} typed repo ${run.repo}, its card ${item.id} is on ${item.repo}`);
    }
    if (run.branch && item.branch && run.branch !== item.branch) {
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
