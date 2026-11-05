/**
 * Who has claimed a backlog card. A claim is explicit (`once-upon backlog claim ID --agent NAME`, an event in
 * backlog.jsonl): the agent, or the session that launched it, says "this card is mine". Nothing is guessed from an agent's
 * task text, its name or its worktree folder. The claim names the agent, and is for one run of it: the first run of that
 * name (pinned to its launching session when the claim gives a sid) that had not ended when the claim was made. It ends
 * when that run finishes or the card lands or is dropped. A card has one claim and an agent may hold several.
 * Pure: the board gathers the facts.
 */
import type { BoardColumn } from '@once-upon-a-diff/contracts/types';
import { sameRepo } from '../config/repos.ts';
import { STALE_MS } from '../ledger/events.ts';
import type { LedgerAgent } from '../ledger/ledger.ts';
import type { BacklogItem } from './types.ts';

/** A claim whose agent has no ledger line yet counts this long (the launcher claims before the agent's first line lands). */
export const CLAIM_GRACE_HOURS = 2;

export const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The key an agent goes by on the board: its launching session and its name (the ledger's own key). */
export const agentKey = (agent: Pick<LedgerAgent, 'sid' | 'name'>): string =>
  `${agent.sid}:${agent.name}`;

/** Whether two agent views are the same agent (a card lists each agent once). A view with no key is nobody's twin. */
export const sameAgentView = (first: { key?: string }, second: { key?: string }): boolean =>
  !!first.key && first.key === second.key;

/** The newest ledger line of the agents with this name: an open one before a finished one, then the latest. */
export function newest(agents: LedgerAgent[]): LedgerAgent | null {
  const stamp = (agent: LedgerAgent) => (agent.ended ?? agent.started)?.getTime() ?? 0;
  return (
    [...agents].sort(
      (first, second) =>
        Number(OPEN.includes(second.state)) - Number(OPEN.includes(first.state)) ||
        stamp(second) - stamp(first),
    )[0] ?? null
  );
}

/** The ledger stamps its times to the minute, so a run that ended "at" the claim's minute did not end before it. */
const LEDGER_MINUTE_MS = 60 * 1000;

/**
 * Which of the agent's runs holds the claim, or null. A claim is for one run: the first one that had not ended before the
 * claim was made, and that began no later than CLAIM_GRACE_HOURS after it (the launcher claims right after launching, so
 * its run's first line can land a little after the claim). An earlier run that ended before the claim does not hold it,
 * and neither does a rerun that starts after the claimed run ended: the claim is over when that run finishes.
 */
function holdingRun(agent: LedgerAgent, claimedAt: number): LedgerAgent | null {
  const runs = [...(agent.earlier ?? []), agent];
  return (
    runs.find(
      (run) =>
        (run.ended === null || run.ended.getTime() + LEDGER_MINUTE_MS > claimedAt) &&
        (run.started === null ||
          run.started.getTime() <= claimedAt + CLAIM_GRACE_HOURS * 3600 * 1000),
    ) ?? null
  );
}

/** The run that holds an item's claim: its agent as that run stood, and whether the run is the agent's latest (still current). */
export interface ClaimRun {
  agent: LedgerAgent;
  current: boolean;
}

/**
 * The run that holds the item's claim, or null: no claim, a dropped or landed item (the claim ends when the card is done),
 * or no run of that name that the claim can be for (it stays pending until the agent's line lands, claimedRun's callers
 * see `liveClaim`).
 */
export function claimedRun(item: BacklogItem, agents: LedgerAgent[]): ClaimRun | null {
  const claim = item.claim;
  const claimedAt = Date.parse(claim?.at ?? '');
  if (!claim || item.state === 'dropped' || item.landed_at || Number.isNaN(claimedAt)) {
    return null;
  }
  const runs: ClaimRun[] = agents
    .filter((one) => one.name === claim.agent && (!claim.sid || one.sid === claim.sid))
    .flatMap((one) => {
      const run = holdingRun(one, claimedAt);
      return run ? [{ agent: run, current: run === one }] : [];
    });
  const best = newest(runs.map((one) => one.agent));
  return runs.find((one) => one.agent === best) ?? null;
}

/** The ledger agent (as the holding run stood) that holds the item's claim, or null. */
export const claimedAgent = (item: BacklogItem, agents: LedgerAgent[]): LedgerAgent | null =>
  claimedRun(item, agents)?.agent ?? null;

/** Each claimed item's agent, by item id. */
export function claimedAgents(
  items: BacklogItem[],
  agents: LedgerAgent[],
): Map<string, LedgerAgent> {
  const found = new Map<string, LedgerAgent>();
  for (const item of items) {
    const agent = claimedAgent(item, agents);
    if (agent) {
      found.set(item.id, agent);
    }
  }
  return found;
}

/** The keys of the agents whose current run holds a claim on a card (a landed or dropped card has ended its claim). */
function currentKeys(items: BacklogItem[], agents: LedgerAgent[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    const run = claimedRun(item, agents);
    if (run?.current) {
      keys.add(agentKey(run.agent));
    }
  }
  return keys;
}

/**
 * The agents that are a claimed card, so the card shows them and they have no card of their own: the agent whose current
 * run holds a claim on a card that is not dropped or landed. A later rerun of a finished claimer is not held.
 */
export const heldKeys = currentKeys;

/** The agents that hold a claim with their current run: what a build slot counts. */
export const claimerKeys = currentKeys;

/**
 * The claim still in force: its run is in the ledger, or it is under CLAIM_GRACE_HOURS old (the agent's line has not
 * landed yet). Null when the item has none, is dropped or landed, or the claim is old and its run never turned up.
 */
export function liveClaim(
  item: BacklogItem,
  agent: unknown,
  nowMs: number,
): { claim: NonNullable<BacklogItem['claim']>; pending: boolean } | null {
  const claim = item.claim;
  if (!claim || item.state === 'dropped' || item.landed_at) {
    return null;
  }
  if (agent) {
    return { claim, pending: false };
  }
  const since = Date.parse(claim.at);
  return !Number.isNaN(since) && nowMs - since <= CLAIM_GRACE_HOURS * 3600 * 1000
    ? { claim, pending: true }
    : null;
}

/**
 * Where a finished, claimed card waits for its critic, or null when nothing holds it back: its latest critic run finished
 * done with no findings, or with findings and the author has finished a fix round since. Read only from registered agents'
 * fields, never their text. A critic is a registered `critic` run on the card (`--card`), or, when it names no card, on the
 * item's repo and branch (a finish event's branch wins). The card is held (Agent checks unless noted) while:
 *
 *   no critic             none is registered for the card yet
 *   critic running        a critic is open (running, or at its fixing gate)
 *   critic did not pass   the latest critic failed or was stopped, or died (open with no sign of life for STALE_MS)
 *   fixes pending         the latest finished critic reported findings (`--findings` above 0) and the author has not finished
 *                         since: Working while the author runs (Agent checks at its fixing gate, Waiting at a question or
 *                         plan), else Agent checks, for the fix round yet to start
 *
 * The author is the claimed agent's latest run (by sid and name) on this card (a run with another `--card` is not): the claim
 * holds the run it was made for, and a fix round is a later run of the same agent. Findings the editor dropped (no fix round)
 * lapse STALE_MS after the critic finished. A later critic run that finishes with `--findings 0` releases the card at once.
 */
export function criticHold(
  item: Pick<BacklogItem, 'id' | 'repo' | 'branch'>,
  claimed: Pick<LedgerAgent, 'sid' | 'name'>,
  agents: LedgerAgent[],
  nowMs: number,
): BoardColumn | null {
  const critics = agents.filter(
    (agent) =>
      agent.source === 'events' &&
      agent.kind === 'critic' &&
      (agent.card
        ? agent.card === item.id
        : !!item.repo &&
          !!item.branch &&
          sameRepo(agent.repo ?? null, item.repo) &&
          (agent.result?.branch ?? agent.branch) === item.branch),
  );
  // a critic with no sign of life for STALE_MS is dead: it holds nothing
  const alive = (critic: LedgerAgent) =>
    OPEN.includes(critic.state) &&
    nowMs - (critic.lastEvent ?? critic.started ?? new Date(nowMs)).getTime() <= STALE_MS;
  if (critics.some(alive)) {
    return 'checks';
  }
  // the latest critic run: a finished one by when it ended, a dead one by its last sign of life
  const settledAt = (critic: LedgerAgent) =>
    (critic.ended ?? critic.lastEvent ?? critic.started)?.getTime() ?? 0;
  const latest = [...critics].sort((first, second) => settledAt(second) - settledAt(first))[0];
  // no critic yet, or the latest one failed, was stopped or died: nothing has passed this card
  if (!latest || latest.state !== 'done') {
    return 'checks';
  }
  if (!(latest.findings && latest.findings > 0)) {
    return null;
  }
  // findings nobody fixed (the editor dropped them all) release the card STALE_MS after the critic finished; a newer
  // critic run that finishes with none releases it at once (a finished run takes no more events)
  if (nowMs - (latest.ended?.getTime() ?? nowMs) > STALE_MS) {
    return null;
  }
  // the author is the claimed agent's latest run for this card: a run registered for another card is not its fix round
  const runs = agents
    .filter((agent) => agent.sid === claimed.sid && agent.name === claimed.name)
    .flatMap((agent) => [...(agent.earlier ?? []), agent])
    .filter((run) => !run.card || run.card === item.id);
  const author = runs[runs.length - 1];
  if (author?.state === 'running') {
    return 'working';
  }
  if (author && OPEN.includes(author.state)) {
    return author.state === 'fixing' ? 'checks' : 'waiting';
  }
  const fixedAt = author?.ended?.getTime() ?? 0;
  return fixedAt > (latest.ended?.getTime() ?? 0) ? null : 'checks';
}
