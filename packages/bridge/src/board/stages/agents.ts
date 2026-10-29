/**
 * The ledger's background agents on the board: which are shown, and where each goes. An agent is nested in its
 * parent's card only when tightly tied to it (agent-home.ts), else it is a card of its own, on its own lane.
 */
import { gatedHome, laneForAgent, tiedToParent } from '../agent-home.ts';
import { gateOf, type LedgerAgent } from '../ledger.ts';
import type {
  BoardAgent,
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

export function agentOf(agent: LedgerAgent, beat: BoardBeat | undefined, now: number): BoardAgent {
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

/** What the agents are placed against. */
export interface AgentFacts {
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  /** the voice session, pinned above the columns, whose agents keep a card of their own */
  pin: PinnedVoice | null;
}

/**
 * Places the agents the board shows (running, at a gate, waiting, or finished within the last few hours). An agent tied
 * to its parent's card, or to the branch or PR its task names, is added to that card's `agents` (which changes the card
 * given). The rest get a card of their own, on their own lane while they run, wait or sit at a gate: these are returned,
 * to go after the others. A finished agent has no card.
 */
export function placeAgents(
  ctx: BuildContext,
  cards: BoardCard[],
  { agents, beats, pin }: AgentFacts,
): BoardCard[] {
  const { nowMs } = ctx;
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
      agent.state === 'running' ||
      (agent.state === 'waiting' && !forgotten(agent, nowMs)) ||
      agent.state === 'plan' ||
      agent.state === 'fixing' ||
      (agent.ended?.getTime() ?? 0) >= nowMs - ctx.settings.doneHours * 3600 * 1000,
  );
  // the lanes already on the board, which an agent's task text can name
  const knownLanes = [
    ...new Set([...cards.map((card) => card.lane), ...agents.flatMap((agent) => agent.lane || [])]),
  ].filter((lane) => lane !== NO_PARENT);
  for (const agent of shown) {
    const view = agentOf(agent, beats.get(agent.name), nowMs);
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
    // an agent gets a card of its own only while it is running, at a gate or waiting on you; a finished one (done,
    // stopped or failed) has none, and its result is in its notes
    if (agent.state === 'done' || agent.state === 'failed' || agent.state === 'stopped') {
      continue;
    }
    // parked on your story review is Ready, not Waiting
    const column: BoardColumn = agent.review ? 'ready' : AGENT_COLUMN[agent.state];
    added.push({
      id: `agent:${agent.sid}:${agent.name}`,
      kind: 'agent',
      title: agent.name,
      repo: null,
      branch: null,
      lane: laneForAgent(agent, knownLanes, parent?.lane ?? voiceParent?.lane ?? null, NO_PARENT),
      column: view.gate ? 'checks' : column,
      detail:
        agent.state === 'waiting' || view.gate?.kind === 'fixing' || view.gate?.kind === 'plan'
          ? view.outcome
          : view.task,
      since: (agent.ended || agent.started)?.toISOString() ?? null,
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
