/**
 * The ledger's background agents on the board: which are shown, and where each goes. An agent is nested in its
 * parent's card only when tightly tied to it (agent-home.ts), else it is a card of its own, on its own lane.
 */
import { gatedHome, laneForAgent, madeSomething, tiedToParent } from '../agent-home.ts';
import { agentKey, claimedAgents } from '../../backlog/claims.ts';
import type { BacklogItem } from '../../backlog/backlog.ts';
import { gateOf, lastActivity, type LedgerAgent } from '../../ledger/ledger.ts';
import { readFinished } from '../../../adapters/stores/finished-agents.ts';
import type {
  BoardAgent,
  BoardBuilders,
  BoardCard,
  BoardBeat,
  BoardColumn,
  BoardStatus,
} from '@once-upon-a-diff/shared/types';
import type { BuildContext, PinnedVoice } from './types.ts';

/** A running agent with no done line this long after it started is marked stale. */
export const STALE_MS = 24 * 3600 * 1000;

export const AGENT_OPEN = ['running', 'waiting', 'plan', 'fixing'];

/** The lane for an agent whose session is gone and that names no lane. */
export const NO_PARENT = 'No live session';

/** A `[waiting]` or `[review]` line this old (its time) is left behind, as the iTerm hook does: no board card, no count. */
export function forgotten(agent: LedgerAgent, nowMs: number): boolean {
  const since = agent.ended ?? agent.started;
  return !!since && nowMs - since.getTime() > STALE_MS;
}

const AGENT_STATUS: Record<LedgerAgent['state'], BoardStatus> = {
  running: 'working',
  waiting: 'waiting',
  plan: 'working',
  fixing: 'working',
  done: 'done',
  failed: 'error',
  stopped: 'done',
};

/** An agent that has finished for good: no more work to do, with or without a result to read. */
export const isFinished = (agent: Pick<LedgerAgent, 'state'>): boolean =>
  agent.state === 'done' || agent.state === 'failed' || agent.state === 'stopped';

export function agentOf(
  agent: LedgerAgent,
  beat: BoardBeat | undefined,
  now: number,
  clearsAt: Date | null = null,
): BoardAgent {
  // still open: running, or at a gate (when it began is the line's time, not the original start)
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  const began = agent.state === 'running' ? agent.started : agent.ended || agent.started;
  return {
    name: agent.name,
    state: agent.state,
    review: !!agent.review,
    status: AGENT_STATUS[agent.state],
    task: agent.task,
    model: agent.model,
    started_at: agent.started?.toISOString() ?? null,
    ended_at: agent.ended?.toISOString() ?? null,
    outcome: agent.outcome,
    stale: open && !!began && now - began.getTime() > STALE_MS,
    beat: beat || null,
    gate: gateOf(agent),
    notes: agent.notes ?? null,
    clears_at: clearsAt?.toISOString() ?? null,
  };
}

export const AGENT_COLUMN: Record<LedgerAgent['state'], BoardColumn> = {
  running: 'working',
  waiting: 'waiting',
  plan: 'checks',
  fixing: 'checks',
  done: 'idle',
  failed: 'error',
  stopped: 'idle',
};

/**
 * The views of the agents that hold a claim, by the id of the card they claimed: what the card shows in place of an
 * agent card of its own (backlog.ts's backlogCards).
 */
export function claimViews(
  items: BacklogItem[],
  agents: LedgerAgent[],
  beats: Map<string, BoardBeat>,
  nowMs: number,
): Map<string, BoardAgent> {
  return new Map(
    [...claimedAgents(items, agents)].map(([id, agent]) => [
      id,
      agentOf(agent, beats.get(agent.name), nowMs),
    ]),
  );
}

/**
 * The voice session's build slots: its running builders, which are the running agents that hold a claim on a card
 * (`claimers`, the keys claims.ts gives; one slot per agent, however many cards it holds). A stale one, running past
 * the stale mark, is likely dead and holds no slot. Null when there is no voice session.
 */
export function builderSlots(
  agents: LedgerAgent[],
  pin: PinnedVoice | null,
  cap: number,
  nowMs: number,
  claimers: Set<string>,
): BoardBuilders | null {
  if (!pin) {
    return null;
  }
  const running = agents
    .filter(
      (agent) =>
        agent.state === 'running' &&
        pin.view.id.startsWith(agent.sid) &&
        claimers.has(agentKey(agent)) &&
        !(agent.started && nowMs - agent.started.getTime() > STALE_MS),
    )
    .sort((first, second) => (first.started?.getTime() ?? 0) - (second.started?.getTime() ?? 0));
  return {
    cap,
    free: Math.max(0, cap - running.length),
    running: running.map((agent) => ({
      name: agent.name,
      task: agent.task,
      since: agent.started?.toISOString() ?? null,
    })),
  };
}

/** What the agents are placed against. */
export interface AgentFacts {
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  /** the voice session, pinned above the columns, whose agents keep a card of their own */
  pin: PinnedVoice | null;
  /** the agents (agentKey) that are a claimed card: they have no card of their own, the claimed card shows them */
  held?: Set<string>;
}

/**
 * Places the agents the board shows (running, at a gate, waiting, or finished within the last few hours), except the held
 * ones: an agent that claimed a backlog card is shown on that card (claims.ts), never here. An agent tied
 * to its parent's card, or to the branch or PR its task names (text: bl_mw12ymyrceec6c replaces it), is added to that card's `agents` (which changes the card
 * given). The rest get a card of their own, on their own lane while they run, wait or sit at a gate: these are returned,
 * to go after the others. A finished agent (done, failed or stopped) gets a card of its own for
 * `finishedWaitMinutes` after its last ledger line, with its outcome, its notes path
 * and its parent session, until the card's Finish clears it: in Done when it made something (a commit, a deploy, a
 * branch, a card; madeSomething), in Waiting when it only researched or failed. A later ledger line brings the card back, with a fresh timer.
 */
export function placeAgents(
  ctx: BuildContext,
  cards: BoardCard[],
  { agents, beats, pin, held = new Set() }: AgentFacts,
): BoardCard[] {
  const { nowMs } = ctx;
  const waitMs = ctx.settings.finishedWaitMinutes * 60 * 1000;
  const cleared = readFinished(ctx.home);
  const added: BoardCard[] = [];
  const cardsBySid = new Map<string, BoardCard>();
  for (const card of cards) {
    for (const session of card.sessions) {
      const sid = session.id.slice(0, 8);
      cardsBySid.set(sid, cardsBySid.get(sid) || card);
    }
  }
  const shown = agents.filter(
    (agent) =>
      !held.has(agentKey(agent)) &&
      (agent.state === 'running' ||
        (agent.state === 'waiting' && !forgotten(agent, nowMs)) ||
        agent.state === 'plan' ||
        agent.state === 'fixing' ||
        (agent.ended?.getTime() ?? 0) >=
          nowMs - Math.max(ctx.settings.doneHours * 3600 * 1000, waitMs)),
  );
  // the lanes already on the board, which an agent's task text can name
  const knownLanes = [
    ...new Set([...cards.map((card) => card.lane), ...agents.flatMap((agent) => agent.lane || [])]),
  ].filter((lane) => lane !== NO_PARENT);
  for (const agent of shown) {
    const active = lastActivity(agent);
    // a finished agent waits until its card's Finish clears it, or `waitMs` after its last sign of life
    const clearsAt =
      isFinished(agent) && active && active.getTime() + waitMs > nowMs
        ? new Date(active.getTime() + waitMs)
        : null;
    const view = agentOf(agent, beats.get(agent.name), nowMs, clearsAt);
    const parent = cardsBySid.get(agent.sid) || null;
    const voiceParent = pin && pin.view.id.startsWith(agent.sid) ? pin : null;
    const parentSession =
      parent?.sessions.find((one) => one.id.startsWith(agent.sid)) ?? voiceParent?.view;
    if (parent && tiedToParent(agent, parent)) {
      parent.agents.push(view);
      continue;
    }
    // an agent at a gate, or parked on your story review, belongs in the card of the branch or PR its task names,
    // wherever its launching session is
    const home =
      view.gate || view.review
        ? gatedHome(agent, cards, parent?.lane ?? voiceParent?.lane ?? null)
        : null;
    if (home) {
      home.agents.push(view);
      continue;
    }
    // a finished agent's card is in Waiting for a while, unless it was cleared and has done nothing since (a ledger line
    // in the minute of the click is not told apart: the times carry no seconds)
    if (isFinished(agent)) {
      const clearedAt = cleared.get(`${agent.sid}:${agent.name}`);
      if (!clearsAt || (clearedAt !== undefined && active && active.getTime() <= clearedAt)) {
        continue;
      }
    }
    // parked on your story review is Ready, not Waiting. A finished agent that made something (madeSomething) is Done; one
    // that only researched, or failed, is in Waiting: there is something to read, or to look into
    let column: BoardColumn = AGENT_COLUMN[agent.state];
    if (isFinished(agent)) {
      column = agent.state !== 'failed' && madeSomething(agent) ? 'done' : 'waiting';
    }
    if (agent.review) {
      column = 'ready';
    }
    added.push({
      id: `agent:${agent.sid}:${agent.name}`,
      kind: 'agent',
      title: agent.name,
      repo: null,
      branch: null,
      lane: laneForAgent(agent, knownLanes, parent?.lane ?? voiceParent?.lane ?? null, NO_PARENT),
      column: view.gate ? 'checks' : column,
      detail:
        agent.state === 'waiting' ||
        isFinished(agent) ||
        view.gate?.kind === 'fixing' ||
        view.gate?.kind === 'plan'
          ? view.outcome
          : view.task,
      since: (isFinished(agent) ? active : agent.ended || agent.started)?.toISOString() ?? null,
      pr: null,
      story: null,
      building: null,
      sessions: [],
      agents: [view],
      // the pinned voice session is named for what it is, not by its tab's title
      parent: voiceParent ? 'Voice session' : (parentSession?.title ?? null),
      focus_session: parentSession?.id ?? null,
      can_focus: parentSession?.focus ?? false,
      listening: null,
      build: null,
    });
  }
  return added;
}
