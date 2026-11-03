/**
 * Who has claimed a backlog card. A claim is explicit (`once-upon backlog claim ID --agent NAME`, an event in
 * backlog.jsonl): the agent, or the session that launched it, says "this card is mine". Nothing is guessed from an agent's
 * task text, its name or its worktree folder. The claim names the agent, and is for one run of it: the first run of that
 * name (pinned to its launching session when the claim gives a sid) that had not ended when the claim was made. It ends
 * when that run finishes or the card lands or is dropped. A card has one claim and an agent may hold several.
 * Pure: the board gathers the facts.
 */
import type { LedgerAgent } from '../ledger/ledger.ts';
import type { BacklogItem } from './backlog.ts';

/** A claim whose agent has no ledger line yet counts this long (the launcher claims before the agent's first line lands). */
export const CLAIM_GRACE_HOURS = 2;

export const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The key an agent goes by on the board: its launching session and its name (the ledger's own key). */
export const agentKey = (agent: Pick<LedgerAgent, 'sid' | 'name'>): string =>
  `${agent.sid}:${agent.name}`;

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
