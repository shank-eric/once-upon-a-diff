/**
 * The background agents on the board: which are shown, and where each goes. An agent is nested in the card its
 * registered repo, branch, PR or card point to (agent-home.ts), else it is a card of its own, on its own lane.
 */
import { resolveLane } from '@once-upon-a-diff/protocol/domain/lane-key';
import {
  finishedColumn,
  finishedSummary,
  homeOf,
  landedFor,
  pendingReview,
} from '../agent-home.ts';
import { agentKey, claimedAgents } from '../../backlog/claims.ts';
import type { BacklogItem } from '../../backlog/backlog.ts';
import { STALE_MS, beatOf } from '../../ledger/events.ts';
import { gateOf, lastActivity, type LedgerAgent } from '../../ledger/ledger.ts';
import { laneOf } from './lanes.ts';
import { readFinished } from '../../../adapters/stores/finished-agents.ts';
import type { WorktreeFacts } from '../../worktrees/worktrees.ts';
import type {
  BoardAgent,
  BoardAgentEditor,
  BoardCard,
  BoardBeat,
  BoardColumn,
  BoardStatus,
} from '@once-upon-a-diff/protocol/types';
import type { BuildContext, PinnedVoice } from './types.ts';

/** A running agent with no done line this long after it started is marked stale. */
export { STALE_MS };

export const AGENT_OPEN = ['running', 'waiting', 'plan', 'fixing'];

/** The lane for an agent whose session is gone and that names no lane. */
export const NO_PARENT = 'No live session';

/** A `[waiting]` or `[review]` line this old (its time) is left behind, as the iTerm hook does: no board card, no count. */
export function forgotten(agent: LedgerAgent, nowMs: number): boolean {
  const since = lastActivity(agent);
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
  editor: BoardAgentEditor | null = null,
): BoardAgent {
  // still open: running, or at a gate (when it began is the line's time, not the original start)
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  // a registered agent's last sign of life is its latest event, a beat included; a ledger agent's is the line's time
  const ledgerBegan = agent.state === 'running' ? agent.started : agent.ended || agent.started;
  const began = agent.source === 'events' ? lastActivity(agent) : ledgerBegan;
  return {
    key: agentKey(agent),
    sid: agent.sid,
    name: agent.name,
    kind: agent.kind ?? null,
    editor,
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
    summary: null,
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
  editorOf: (agent: LedgerAgent) => BoardAgentEditor | null = () => null,
): Map<string, BoardAgent> {
  return new Map(
    [...claimedAgents(items, agents)].map(([id, agent]) => [
      id,
      agentOf(agent, beatOf(agent, beats), nowMs, null, editorOf(agent)),
    ]),
  );
}

/**
 * The lane key for an agent with its own card: its explicit lane tag (resolved to the one known "owner/name" it is the short
 * name of), else the lane of its registered repo, else its launching session's lane (by sid), else "No live session".
 * Nothing is read from its task.
 */
function laneOfAgent(agent: LedgerAgent, knownLanes: string[], parentLane: string | null): string {
  if (agent.lane) {
    return resolveLane(agent.lane, knownLanes);
  }
  return (agent.repo ? laneOf(agent.cwd ?? '', agent.repo) : null) || parentLane || NO_PARENT;
}

/** What the agents are placed against. */
export interface AgentFacts {
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  /** the voice session, pinned above the columns, whose agents keep a card of their own */
  pin: PinnedVoice | null;
  /** the agents (agentKey) that are a claimed card: they have no card of their own, the claimed card shows them */
  held?: Set<string>;
  /** the backlog's items, which an agent's registered `card` points into */
  items?: BacklogItem[];
  /** the editor that controls an agent, when one does (editors.ts) */
  editorOf?: (agent: LedgerAgent) => BoardAgentEditor | null;
  /** what the worktree scanner has (memory only): whether a finished author's branch is merged (pendingReview) */
  trees?: WorktreeFacts[];
}

/**
 * Places the agents the board shows (running, at a gate, waiting, or finished within the last few hours), except the held
 * ones: an agent that claimed a backlog card is shown on that card (claims.ts), never here. An agent with a home (agent-home.ts: the card its registered repo and branch, PR or card point to) is added to that card's `agents` (which changes the card
 * given). The rest get a card of their own, on their own lane while they run, wait or sit at a gate: these are returned,
 * to go after the others. A finished agent (done, failed or stopped) gets a card of its own for
 * `finishedWaitMinutes` after its last ledger line, with its outcome, its notes path
 * and its parent session, until the card's Finish clears it: in Done when it made something (a finish
 * event's commit, PR, branch or card, or a ledger `[done]` line), in Research when a research run finished
 * with no result, in Waiting when it failed, was stopped, or is an author that made nothing (finishedColumn; a done
 * agent whose registered card landed made something). An author whose commit is on a branch with no PR that is not merged
 * is in Ready for your review (pendingReview), and stays there with no timer until Finish clears it, the branch gets a
 * PR, merges, moves on or loses its worktree, or a week has passed (the time a Finish is kept). Its `summary` says what it did and why it is done. An
 * author's card in Waiting stays `doneHours` (an hour), not `finishedWaitMinutes`. A later ledger line brings the card back, with a fresh timer.
 */
export function placeAgents(
  ctx: BuildContext,
  cards: BoardCard[],
  {
    agents,
    beats,
    pin,
    held = new Set(),
    items = [],
    editorOf = () => null,
    trees = [],
  }: AgentFacts,
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
  // a finished author's commit waiting on your review (read from what the scanner and GitHub already said; asks nothing)
  const pendingOf = new Map(
    agents.map((agent) => [
      agent,
      pendingReview(agent, trees, (repo, branch) => ctx.review.branchPr(repo, branch), nowMs),
    ]),
  );
  const shown = agents.filter(
    (agent) =>
      !held.has(agentKey(agent)) &&
      (agent.state === 'running' ||
        !!pendingOf.get(agent) ||
        (agent.state === 'waiting' && !forgotten(agent, nowMs)) ||
        agent.state === 'plan' ||
        agent.state === 'fixing' ||
        (agent.ended?.getTime() ?? 0) >=
          nowMs - Math.max(ctx.settings.doneHours * 3600 * 1000, waitMs)),
  );
  // the lanes already on the board, which a lane tag (`lane:<name>`, usually a short name) can stand for
  const knownLanes = [
    ...new Set([...cards.map((card) => card.lane), ...agents.flatMap((agent) => agent.lane || [])]),
  ].filter((lane) => lane !== NO_PARENT);
  for (const agent of shown) {
    const active = lastActivity(agent);
    // a finished agent waits until its card's Finish clears it, or `waitMs` after its last sign of life; an author (kind
    // author) that finished with no result sits in Waiting for `doneHours` instead, an hour by default
    const item = agent.card ? items.find((one) => one.id === agent.card) : undefined;
    const pending = pendingOf.get(agent) ?? null;
    const finishedIn = isFinished(agent)
      ? finishedColumn(agent, landedFor(agent, item), pending)
      : null;
    const staysMs =
      finishedIn === 'waiting' && agent.kind === 'author'
        ? Math.max(waitMs, ctx.settings.doneHours * 3600 * 1000)
        : waitMs;
    // Ready for your review has no timer: it stays until Finish clears it, or the branch gets a PR or merges
    const clearsAt =
      finishedIn !== 'ready' && isFinished(agent) && active && active.getTime() + staysMs > nowMs
        ? new Date(active.getTime() + staysMs)
        : null;
    const view = agentOf(agent, beatOf(agent, beats), nowMs, clearsAt, editorOf(agent));
    const parent = cardsBySid.get(agent.sid) || null;
    const voiceParent = pin && pin.view.id.startsWith(agent.sid) ? pin : null;
    const parentSession =
      parent?.sessions.find((one) => one.id.startsWith(agent.sid)) ?? voiceParent?.view;
    // a finished agent is gone once its card's Finish cleared it and it has done nothing since (a ledger line in the
    // minute of the click is not told apart: the times carry no seconds), wherever it would sit
    const clearedAt = isFinished(agent) ? cleared.get(agentKey(agent)) : undefined;
    const wasCleared = clearedAt !== undefined && !!active && active.getTime() <= clearedAt;
    if (wasCleared) {
      continue;
    }
    // an agent belongs in the card its registered repo, branch, PR or card point to, wherever its launching session is
    const home = homeOf(agent, cards, items);
    if (home) {
      home.agents.push(view);
      continue;
    }
    // a finished agent's own card is in its column for a while
    if (isFinished(agent) && !clearsAt && finishedIn !== 'ready') {
      continue;
    }
    // parked on your story review is Ready, not Waiting. A finished agent's column is finishedColumn's: Done when it made
    // something, Research when it only looked, Waiting when it failed or an author made nothing
    let column: BoardColumn = finishedIn ?? AGENT_COLUMN[agent.state];
    if (isFinished(agent)) {
      view.summary = finishedSummary(agent, item, pending);
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
      lane: laneOfAgent(agent, knownLanes, parent?.lane ?? voiceParent?.lane ?? null),
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
