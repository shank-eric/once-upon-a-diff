/**
 * The background agents on the board: which are shown, and where each goes. An agent whose run names a card is on that card
 * (ADR-25); every other agent is a card of its own, on its own lane.
 */
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { agentWorkKey, isSelfName } from '@once-upon-a-diff/terms/ids';
import {
  finishedColumn,
  finishedSummary,
  landedFor,
  leftUncommitted,
  pendingReview,
  type PendingReview,
} from '../agent-home.ts';
import { readyColumn } from '@once-upon-a-diff/state/queues/backlog/ready';
import { readyFactsFor } from './ready-facts.ts';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import {
  agentsOnCard,
  coveringRun,
  runsOnBranch,
} from '@once-upon-a-diff/state/queues/backlog/phase';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import { isEndState } from '@once-upon-a-diff/contracts/files/agent-states';
import { STALE_MS, staleAfterMs } from '@once-upon-a-diff/state/records/agents/events';
import {
  gateOf,
  isAcked,
  isStoryteller,
  lastActivity,
  type LedgerAgent,
} from '@once-upon-a-diff/state/records/agents/ledger';
import { cardOnBranch, isListed } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { laneOf } from './lanes.ts';
import { KEEP_MS, readFinished } from '@once-upon-a-diff/adapters/stores/finished-agents';
import type { WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type {
  BoardAgent,
  BoardAgentEditor,
  BoardCard,
  BoardColumn,
  BoardSession,
  BoardStatus,
} from '@once-upon-a-diff/contracts/types';
import { homeOf, NO_HOMES, type Homes } from './homes.ts';
import type { BuildContext, PinnedVoice } from './types.ts';

export const AGENT_OPEN = ['running', 'waiting', 'plan', 'fixing'];

/** The lane for an agent whose session is gone and that names no lane. */
export const NO_PARENT = 'No live session';

/** A waiting or review agent whose last event is this old is left behind, as the iTerm hook does: no board card, no count. */
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
export const isFinished = (agent: Pick<LedgerAgent, 'state'>): boolean => isEndState(agent.state);

/**
 * A failed helper run that a retry replaced: another run of the same session started with `--replaces <this run's name>` and
 * finished done (a deploy that failed, then the deploy that worked). It is not news, so it has no card. Only the link the retry
 * registered is read, never the task or outcome text, the repo or the order of the runs. A failed run nobody replaced stays in
 * Waiting until its `finishedWaitMinutes` pass, as any finished run does.
 */
function replacedByRetry(agent: LedgerAgent, all: LedgerAgent[]): boolean {
  return (
    agent.state === 'failed' &&
    agent.kind === 'helper' &&
    all.some(
      (other) => other.state === 'done' && other.sid === agent.sid && other.replaces === agent.name,
    )
  );
}

/** A finished run of a stored card that was dropped: the card is gone from the board, the run stays in the ledger. */
const droppedCard = (agent: LedgerAgent, items: BacklogItem[]): boolean =>
  isFinished(agent) &&
  !!agent.card &&
  items.some((item) => item.id === agent.card && item.state === 'dropped');

/**
 * Still open (running, or at a gate) with no sign of life for longer than it may be silent: left behind, holding nothing.
 * Its last sign of life is its latest event, a beat included.
 */
function isStale(agent: LedgerAgent, now: number): boolean {
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  const began = lastActivity(agent);
  return open && !!began && now - began.getTime() > staleAfterMs(agent);
}

/** Open (running, or at a gate) and not stale: work going on now. The one test the agent's own row and a session's launched agents share. */
export function isRunning(agent: LedgerAgent, now: number): boolean {
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  return open && !isStale(agent, now);
}

function agentOf(
  agent: LedgerAgent,
  now: number,
  clearsAt: Date | null = null,
  editor: BoardAgentEditor | null = null,
): BoardAgent {
  const stale = isStale(agent, now);
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
    model: agent.modelName,
    started_at: agent.started?.toISOString() ?? null,
    ended_at: agent.ended?.toISOString() ?? null,
    outcome: agent.outcome,
    stale,
    beat: agent.beat ?? null,
    // a storyteller that went quiet for an hour is dead and holds nothing (the sweep never closes it)
    gate: stale && isStoryteller(agent) ? null : gateOf(agent),
    notes: agent.notes ?? null,
    clears_at: clearsAt?.toISOString() ?? null,
    summary: null,
  };
}

const AGENT_COLUMN: Record<LedgerAgent['state'], BoardColumn> = {
  running: 'working',
  waiting: 'waiting',
  plan: 'checks',
  fixing: 'checks',
  done: 'idle',
  failed: 'error',
  stopped: 'idle',
};

/**
 * The views of the agents on each card, by the id of the card: what the card shows in place of agent cards of its own
 * (backlog.ts's backlogCards). A card named by runs (`card` on an agent's start) shows each of those agents, its latest run
 * on the card, critics and fix rounds included.
 */
export function runViews(
  items: BacklogItem[],
  agents: LedgerAgent[],
  nowMs: number,
  editorOf: (agent: LedgerAgent) => BoardAgentEditor | null = () => null,
): Map<string, BoardAgent[]> {
  const views = new Map<string, BoardAgent[]>();
  for (const item of items) {
    if (item.state === 'dropped') {
      continue;
    }
    // the agents whose runs name the card
    // an acknowledged failed run is dismissed: it is no line on the card (the card's "tried" chip still names it, as stopped)
    const found = agentsOnCard(item, agents).filter((agent) => !isAcked(agent));
    if (found.length) {
      views.set(
        item.id,
        found.map((agent) => agentOf(agent, nowMs, null, editorOf(agent))),
      );
    }
  }
  return views;
}

/**
 * The lane key for an agent with its own card: the lane of its registered repo, else its launching session's lane (by sid),
 * else "No live session". Nothing is read from its task.
 */
function laneOfAgent(agent: LedgerAgent, parentLane: string | null): string {
  return (agent.repo ? laneOf(agent.cwd ?? '', agent.repo) : null) || parentLane || NO_PARENT;
}

/** What the agents are placed against. */
export interface AgentFacts {
  agents: LedgerAgent[];
  /** the voice session, pinned above the columns, whose agents keep a card of their own */
  pin: PinnedVoice | null;
  /** the editors' sessions, on no card: the parent of an agent launched from one */
  editorViews?: EditorView[];
  /** the agents (agentKey) whose run names a card: they have no card of their own, the card shows them */
  held?: Set<string>;
  /** the backlog's items, which an agent's registered `card` points into */
  items?: BacklogItem[];
  /** every stored card (`items` is the listed ones): a run on a stored card nobody listed has that card's agent card */
  stored?: BacklogItem[];
  /** the editor that controls an agent, when one does (editors.ts) */
  editorOf?: (agent: LedgerAgent) => BoardAgentEditor | null;
  /** what the worktree scanner has (memory only): whether a finished author's branch is merged (pendingReview) */
  trees?: WorktreeFacts[];
  /** where each stored card is shown (homes.ts): an agent card of an implicit card rides on its home */
  homes?: Homes;
}

/** A pending commit whose branch moved, marked `outside` when no run of the branch accounts for the tip (`coveringRun`). */
function withOutside(
  pending: PendingReview | null,
  agent: LedgerAgent,
  agents: LedgerAgent[],
  nowMs: number,
): PendingReview | null {
  if (!pending?.working || !agent.repo) {
    return pending;
  }
  const covered = coveringRun(runsOnBranch(agents, agent.repo, pending.branch), pending.tip, nowMs);
  return covered ? pending : { ...pending, outside: true };
}

interface Staying {
  active: Date | null;
  item: BacklogItem | undefined;
  pending: PendingReview | null;
  finishedIn: BoardColumn | null;
  clearsAt: Date | null;
}

/**
 * Where a shown agent stands in its column and when its card clears, or null when it has no card: a finished agent is gone
 * once its card's Finish cleared it and it has done nothing since, and a finished agent's own card is in its column for a
 * while (until `clearsAt`, or with no timer while a commit waits on you).
 */
function staying(
  ctx: BuildContext,
  agent: LedgerAgent,
  agents: LedgerAgent[],
  facts: {
    items: BacklogItem[];
    cleared: Map<string, number>;
    pending: PendingReview | null;
  },
): Staying | null {
  const active = lastActivity(agent);
  const clearedAt = isFinished(agent) ? facts.cleared.get(agentKey(agent)) : undefined;
  if (clearedAt !== undefined && !!active && active.getTime() <= clearedAt) {
    return null;
  }
  const item = agent.card ? facts.items.find((one) => one.id === agent.card) : undefined;
  const pending = withOutside(facts.pending, agent, agents, ctx.nowMs);
  const finishedIn = isFinished(agent)
    ? finishedColumn(agent, landedFor(agent, item), pending)
    : null;
  const waitsOnYou = waitsOnYouIn(finishedIn);
  const staysMs = staysFor(ctx, agent, finishedIn);
  const clearsAt =
    !waitsOnYou && isFinished(agent) && active && active.getTime() + staysMs > ctx.nowMs
      ? new Date(active.getTime() + staysMs)
      : null;
  if (isFinished(agent) && !clearsAt && !waitsOnYou) {
    return null;
  }
  return { active, item, pending, finishedIn, clearsAt };
}

/** Each card's sessions by the first 8 characters of their id: the parent an agent's `sid` finds. */
function cardsBySession(cards: BoardCard[]): Map<string, BoardCard> {
  const bySid = new Map<string, BoardCard>();
  for (const card of cards) {
    for (const session of card.sessions) {
      const sid = session.id.slice(0, 8);
      bySid.set(sid, bySid.get(sid) || card);
    }
  }
  return bySid;
}

/** A finished author's commit waiting on your review (read from what the scanner and GitHub already said; asks nothing). */
function pendingReviews(
  ctx: BuildContext,
  agents: LedgerAgent[],
  trees: WorktreeFacts[],
): Map<LedgerAgent, PendingReview | null> {
  const { nowMs } = ctx;
  return new Map(
    agents.map((agent) => [
      agent,
      pendingReview(
        agent,
        trees,
        (repo, branch) => ctx.review.branchPr(repo, branch),
        nowMs,
        // the PR number an author typed at finish counts once GitHub has answered for it (asked only for a finished
        // author's commit that passed pendingReview's other checks)
        (repo, number) => {
          ctx.review.kickInfo(repo, number, nowMs);
          return ctx.review.info(repo, number);
        },
        {
          past: (tree, commit, tip) =>
            ctx.lookups.movedPast(tree.path, commit, tip, tree.defaultBranch),
          carried: (repo, branch, tip) =>
            agents.some(
              (other) =>
                other.kind === 'author' &&
                !!other.repo &&
                sameRepo(other.repo, repo) &&
                (other.result?.branch ?? other.branch) === branch &&
                (other.result?.commit?.length ?? 0) >= 7 &&
                tip.startsWith(other.result?.commit?.toLowerCase() ?? ''),
            ),
        },
      ),
    ]),
  );
}

/** Whether an agent is still worth a card: running, at a gate, waiting, or finished recently enough. */
function isShown(
  ctx: BuildContext,
  agent: LedgerAgent,
  pending: PendingReview | null | undefined,
): boolean {
  const { nowMs } = ctx;
  const waitMs = ctx.settings.finishedWaitMinutes * 60 * 1000;
  if (
    agent.state === 'running' ||
    !!pending ||
    agent.state === 'plan' ||
    agent.state === 'fixing'
  ) {
    return true;
  }
  if (leftUncommitted(agent) && nowMs - (lastActivity(agent)?.getTime() ?? 0) < KEEP_MS) {
    return true;
  }
  if (agent.state === 'waiting' && !forgotten(agent, nowMs)) {
    return true;
  }
  return (
    (agent.ended?.getTime() ?? 0) >= nowMs - Math.max(ctx.settings.doneHours * 3600 * 1000, waitMs)
  );
}

/** The agents the board shows, minus the held ones, a retried run's predecessors, acked runs and dropped cards. */
function shownAgents(
  ctx: BuildContext,
  agents: LedgerAgent[],
  held: Set<string>,
  stored: BacklogItem[],
  pendingOf: Map<LedgerAgent, PendingReview | null>,
): LedgerAgent[] {
  return agents.filter(
    (agent) =>
      !held.has(agentKey(agent)) &&
      !replacedByRetry(agent, agents) &&
      !isAcked(agent) &&
      !droppedCard(agent, stored) &&
      isShown(ctx, agent, pendingOf.get(agent)),
  );
}

/** How long a finished agent's card stays: an author that failed or made nothing sits for `doneHours` instead. */
function staysFor(ctx: BuildContext, agent: LedgerAgent, finishedIn: BoardColumn | null): number {
  const waitMs = ctx.settings.finishedWaitMinutes * 60 * 1000;
  const madeNothing = !agent.result || Object.keys(agent.result).length === 0;
  const longer = finishedIn === 'error' || (finishedIn === 'done' && madeNothing);
  return agent.kind === 'author' && longer
    ? Math.max(waitMs, ctx.settings.doneHours * 3600 * 1000)
    : waitMs;
}

/**
 * A commit waiting on you (Ready for your review, Ready to ship, PR open) has no timer: it stays until Finish clears it,
 * the branch merges or moves on.
 */
function waitsOnYouIn(finishedIn: BoardColumn | null): boolean {
  return (
    finishedIn === 'ready' ||
    finishedIn === 'working' ||
    finishedIn === 'ship' ||
    finishedIn === 'pr_open'
  );
}

/** The column of an agent's card, before a gate moves it to Checks. */
function agentColumn(
  ctx: BuildContext,
  agent: LedgerAgent,
  finishedIn: BoardColumn | null,
  trees: WorktreeFacts[],
): BoardColumn {
  // a story review is asked on committed work: pushed with no PR is Ready to ship, an open PR is PR open, else Ready
  if (agent.review) {
    return readyColumn(
      readyFactsFor(
        ctx.review,
        {
          repo: agent.repo ?? null,
          branch: agent.result?.branch ?? agent.branch ?? null,
          typedPr: agent.result?.pr,
        },
        trees,
        ctx.nowMs,
        { commit: agent.result?.commit, movedPast: ctx.lookups.movedPast },
      ),
    );
  }
  // a research run still out finding something is Thinking, not Working with the authors (once finished it is Research)
  if (agent.kind === 'research' && agent.state === 'running') {
    return 'thinking';
  }
  // parked on your story review is Ready, not Waiting. A finished agent's column is finishedColumn's: Done when it made
  // something or nothing was asked, Research when it only looked, Error when it failed
  return finishedIn ?? AGENT_COLUMN[agent.state];
}

/** Where a run goes when it joins a card that is already on the board, or null when it gets a card of its own. */
interface Landing {
  heads: Map<string, { card: BoardCard; agent: LedgerAgent; stale: boolean }>;
  cards: BoardCard[];
  homes: Homes;
}

/**
 * Puts a run on the card it belongs to when there is one (and says so): an implicit card that already has a work (or
 * session) card rides on it, as a backlog card does (homes.ts): one piece of work, one card. A
 * storyteller started with --pr or --branch and no card joins its PR's work card the same way; any other run with no card
 * never nests. A later run of an implicit card goes on the card of its head, which keeps the head's column unless the head
 * is over and this run is still going: then it is this run's.
 */
function joinExistingCard(
  { heads, cards, homes }: Landing,
  agent: LedgerAgent,
  view: BoardAgent,
  column: BoardColumn,
  implicitId: string | null,
): boolean {
  const branch = agent.result?.branch ?? agent.branch;
  const joins = implicitId || (!agent.card && isStoryteller(agent));
  const place = agent.repo && branch ? { repo: agent.repo, branch } : null;
  let home: BoardCard | null | undefined = null;
  if (joins && place) {
    home = implicitId ? homeOf(homes, implicitId, place, cards) : cardOnBranch(place, cards);
  }
  if (home) {
    home.agents.push(view);
    return true;
  }
  const head = implicitId ? heads.get(implicitId) : undefined;
  if (!head) {
    return false;
  }
  head.card.agents.push(view);
  // a run silent for STALE_MS (a storyteller the sweep never closes) never decides the card's column, as the head or
  // not: a live run takes it from a finished or a silent head, and a finished run takes it from a silent head
  if (!view.stale && (head.stale || (isFinished(head.agent) && !isFinished(agent)))) {
    head.card.column = view.gate ? 'checks' : column;
    head.stale = false;
  }
  return true;
}

type EditorView = { lane: string; view: BoardSession };

interface Parent {
  card: BoardCard | null;
  voice: PinnedVoice | null;
  editor: EditorView | undefined;
  session: BoardSession | undefined;
}

/** The session an agent was started from: on a card, the pinned voice session or an editor's. */
function parentOf(
  agent: LedgerAgent,
  cardsBySid: Map<string, BoardCard>,
  pin: PinnedVoice | null,
  editorViews: EditorView[],
): Parent {
  const card = cardsBySid.get(agent.sid) || null;
  const voice = pin && pin.view.id.startsWith(agent.sid) ? pin : null;
  const editor = editorViews.find((one) => one.view.id.startsWith(agent.sid));
  const session =
    card?.sessions.find((one) => one.id.startsWith(agent.sid)) ?? voice?.view ?? editor?.view;
  return { card, voice, editor, session };
}

/** An agent's own card, for one that did not join another. */
function agentCard(
  agent: LedgerAgent,
  view: BoardAgent,
  column: BoardColumn,
  parent: Parent,
  active: Date | null,
  finishedIn: BoardColumn | null,
  pending: PendingReview | null,
): BoardCard {
  const lane = parent.card?.lane ?? parent.voice?.lane ?? parent.editor?.lane ?? null;
  const showsOutcome =
    agent.state === 'waiting' ||
    isFinished(agent) ||
    view.gate?.kind === 'fixing' ||
    view.gate?.kind === 'plan';
  return {
    id: agentWorkKey(agent.sid, agent.name),
    kind: 'agent',
    // a parent session's own run has no name worth showing: it is titled by its session
    title: isSelfName(agent.name) ? (parent.session?.title ?? agent.name) : agent.name,
    repo: null,
    branch: null,
    lane: laneOfAgent(agent, lane),
    column: view.gate ? 'checks' : column,
    detail: showsOutcome ? view.outcome : view.task,
    since: (isFinished(agent) ? active : agent.ended || agent.started)?.toISOString() ?? null,
    pr: null,
    story: null,
    building: null,
    sessions: [],
    agents: [view],
    // the pinned voice session is named for what it is, not by its tab's title
    parent: parent.voice ? 'Voice session' : (parent.session?.title ?? null),
    focus_session: parent.session?.id ?? null,
    can_focus: parent.session?.focus ?? false,
    listening: null,
    build: null,
    // a commit waiting on your review: Review and Build story work on its branch's worktree
    ...((finishedIn === 'ready' || finishedIn === 'ship') && pending
      ? { review: { branch: pending.branch, path: pending.path } }
      : {}),
    // moved past the commit with no run behind the tip: Record as fix
    ...(finishedIn === 'working' && pending?.outside && agent.repo
      ? {
          outside: {
            sha: pending.tip,
            branch: pending.branch,
            repo: agent.repo,
            path: pending.path,
          },
        }
      : {}),
  };
}

/**
 * Places the agents the board shows (running, at a gate, waiting, or finished within the last few hours), except the held
 * ones: an agent whose run names a card is shown on that card (phase.ts), never here. An implicit card whose repo and branch
 * have a work card is added to that card's `agents` (which changes the card given). The rest get a card of their own, on their own lane while they run, wait or sit at a gate: these are returned,
 * to go after the others. A finished agent (done, failed or stopped) gets a card of its own for
 * `finishedWaitMinutes` after its last event, with its outcome, its notes path
 * and its parent session, until the card's Finish clears it: in Done when it made something (a finish
 * event's commit, PR, branch or card), in Research when a research run finished
 * with no result, in Error when it failed, in Done when it was stopped or is an author that made nothing (finishedColumn; a done
 * agent whose registered card landed made something). An author whose commit is on a branch that is not merged is
 * in Ready for your review (not pushed), Ready to ship (pushed, GitHub says no PR) or PR open (an open PR) (pendingReview,
 * pendingColumn; Working instead of Ready when its branch has since moved past the commit with a later commit or an amend,
 * unless another run's finished commit is the tip), and stays there with no timer until Finish clears it, the branch merges,
 * moves on or loses its worktree, or a week has passed (the time a Finish is kept). Its `summary` says what it did and why it is done. An
 * author's card in Error, or in Done with no result, stays `doneHours` (an hour), not `finishedWaitMinutes`. A later event brings the card back, with a fresh timer.
 */
export function placeAgents(
  ctx: BuildContext,
  cards: BoardCard[],
  {
    agents,
    pin,
    editorViews = [],
    held = new Set(),
    items = [],
    stored = items,
    editorOf = () => null,
    trees = [],
    homes = NO_HOMES,
  }: AgentFacts,
): BoardCard[] {
  const { nowMs } = ctx;
  const cleared = readFinished(ctx.home);
  const added: BoardCard[] = [];
  // the first agent card of each agent card (a stored `source: agent` card, ADR-29): its other runs (a critic of the work) are views on it
  const heads: Landing['heads'] = new Map();
  const cardsBySid = cardsBySession(cards);
  const pendingOf = pendingReviews(ctx, agents, trees);
  for (const agent of shownAgents(ctx, agents, held, stored, pendingOf)) {
    const stay = staying(ctx, agent, agents, {
      items,
      cleared,
      pending: pendingOf.get(agent) ?? null,
    });
    if (!stay) {
      continue;
    }
    const { active, item, pending, finishedIn, clearsAt } = stay;
    const view = agentOf(agent, nowMs, clearsAt, editorOf(agent));
    if (isFinished(agent)) {
      view.summary = finishedSummary(agent, item, pending);
    }
    const column = agentColumn(ctx, agent, finishedIn, trees);
    // a run on a stored card nobody listed that already has its agent card goes on that card, not on a card of its own
    const kept = agent.card ? stored.find((one) => one.id === agent.card) : undefined;
    const implicitId = kept && !isListed(kept) ? kept.id : null;
    if (joinExistingCard({ heads, cards, homes }, agent, view, column, implicitId)) {
      continue;
    }
    const parent = parentOf(agent, cardsBySid, pin, editorViews);
    const placed = agentCard(agent, view, column, parent, active, finishedIn, pending);
    if (implicitId) {
      heads.set(implicitId, { card: placed, agent, stale: view.stale });
    }
    added.push(placed);
  }
  return added;
}
