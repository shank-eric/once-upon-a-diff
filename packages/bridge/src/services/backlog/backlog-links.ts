/**
 * What a started backlog item is being worked by, found from three places (the `start` event only says a branch and
 * who started it, `by`):
 *
 *   worktrees   any git worktree on that branch, in the checkouts the board knows for the item's repo
 *   sessions    any live session on that branch, or working inside such a worktree
 *   agent       the ledger agent whose name is the `by` of the start (the way a subagent says "this is mine"), or is the
 *               name of the branch's worktree folder or of its last segment (voice/speaker-cluster: speaker-cluster), or
 *               whose task names a `<repo>-worktrees/<branch>` folder; with its latest progress beat
 *
 * and whether the branch's work has merged. An agent also counts when its task names the item's id (`card bl_...`),
 * which is how a launcher says "this card is mine" without a branch or a `start` (an open item is linked by that alone:
 * `agentLinks`). The one place for those rules. Pure: board.ts gathers the facts.
 */
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';
import type { BoardBeat, BoardStartedLinks } from '@once-upon-a-diff/shared/types';
import { parseWorktreeEntries } from '../worktrees/worktrees.ts';
import type { LedgerAgent } from '../ledger/ledger.ts';
import type { BacklogItem } from './backlog.ts';
import { DEFAULT_BRANCHES } from '../review/story-lists.ts';

/** One checkout of a repo, as `git worktree list --porcelain` gives it. */
export interface Worktree {
  path: string;
  /** the branch checked out there, null when detached */
  branch: string | null;
}

/** The worktrees in `git worktree list --porcelain` output (worktrees.ts has the fuller parse). */
export function parseWorktrees(text: string): Worktree[] {
  return parseWorktreeEntries(text).map((entry) => ({ path: entry.path, branch: entry.branch }));
}

/** A live session as the links look at it. */
export interface LinkSession {
  id: string;
  title: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
}

export interface LinkFacts {
  /** the worktrees of the checkouts known for each repo (key: the repo, lowercase) */
  worktrees: Map<string, Worktree[]>;
  sessions: LinkSession[];
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  /**
   * whether the repo's branch has merged (a merged PR the board knows of, or its commits are in the main checkout's
   * branch): null when not, else when it did (ms; null inside when that isn't known)
   */
  merged: (repo: string | null, branch: string) => { at: number | null } | null;
}

const insideOf = (dir: string, parent: string): boolean =>
  dir === parent || dir.startsWith(parent + path.sep);

const OPEN: LedgerAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The newest ledger line of the agents with this name: an open one before a finished one, then the latest. */
function newest(agents: LedgerAgent[]): LedgerAgent | null {
  const stamp = (agent: LedgerAgent) => (agent.ended ?? agent.started)?.getTime() ?? 0;
  return (
    [...agents].sort(
      (first, second) =>
        Number(OPEN.includes(second.state)) - Number(OPEN.includes(first.state)) ||
        stamp(second) - stamp(first),
    )[0] ?? null
  );
}

/**
 * The card an agent's task claims: the first `card bl_<id>` (or `backlog bl_<id>`) in it, as a whole token. An id
 * mentioned in passing ("see bl_x", a second card after "then") is not a claim, and neither is a reviewer's (`review-`):
 * only the agent that owns a card moves it.
 */
const CLAIM_RE = /(?<![\w-])(?:card|backlog(?: item)?)\s+(bl_[a-z0-9]{6,24})(?![\w-])/i;

export function claimedId(task: string | null | undefined): string | null {
  return (task && CLAIM_RE.exec(task)?.[1]) || null;
}

/** Whether the agent owns the item: its task claims the id, and it is not a reviewer. */
export function claims(agent: Pick<LedgerAgent, 'name' | 'task'>, id: string): boolean {
  return !/^review-/i.test(agent.name) && claimedId(agent.task) === id;
}

/** The ledger agent that owns an open item: the newest that claims its id. Null when none does. */
export function owningAgent(item: BacklogItem, agents: LedgerAgent[]): LedgerAgent | null {
  return item.state === 'open' ? newest(agents.filter((one) => claims(one, item.id))) : null;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tokenIn = (text: string, word: string) =>
  new RegExp(
    `(?<![\\w/.-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`,
    'i',
  ).test(text);

/**
 * The worktree an owning agent is working in, the way a started item's agent is found from its branch, turned round: a
 * worktree whose folder (or branch's last segment) is the agent's name or its tail (`ou-squash-ship` works in `squash-ship`),
 * or that the task names (`<repo>-worktrees/<folder>`, or the branch). A default branch is never one. Null when none is.
 */
export function worktreeOfAgent(agent: LedgerAgent, trees: Worktree[]): Worktree | null {
  const name = agent.name.toLowerCase();
  const task = agent.task ?? '';
  const hit = (tree: Worktree): boolean => {
    const folder = path.basename(tree.path).toLowerCase();
    const last = (tree.branch ?? '').split('/').pop()?.toLowerCase() ?? '';
    return (
      [folder, last].some((one) => !!one && (name === one || name.endsWith(`-${one}`))) ||
      new RegExp(`-worktrees/${escapeRe(path.basename(tree.path))}(?![\\w./-])`).test(task) ||
      (!!tree.branch && tokenIn(task, tree.branch))
    );
  };
  return (
    trees
      .filter((tree) => tree.branch && !DEFAULT_BRANCHES.has(tree.branch) && hit(tree))
      .sort(
        (first, second) => path.basename(second.path).length - path.basename(first.path).length,
      )[0] ?? null
  );
}

/** The link for an open item an agent owns: the agent only (a branch it works on is `worktreeOfAgent`, and makes it started). */
export function agentLinks(
  item: BacklogItem,
  facts: Pick<LinkFacts, 'agents' | 'beats'>,
): BoardStartedLinks | null {
  const agent = owningAgent(item, facts.agents);
  if (!agent) {
    return null;
  }
  return {
    worktrees: [],
    sessions: [],
    agent: agentLink(agent, facts),
    merged: false,
    merged_at: null,
    active: OPEN.includes(agent.state),
    branch: null,
  };
}

function agentLink(
  agent: LedgerAgent,
  facts: Pick<LinkFacts, 'beats'>,
): NonNullable<BoardStartedLinks['agent']> {
  return {
    name: agent.name,
    state: agent.state,
    beat: facts.beats.get(agent.name) ?? null,
    outcome: agent.outcome,
    ended_at: agent.ended ? agent.ended.toISOString() : null,
  };
}

/** What is working a started item. `active` says there is something to show past the day: unmerged, with a link. */
export function startedLinks(item: BacklogItem, facts: LinkFacts): BoardStartedLinks | null {
  const branch = item.branch;
  if (item.state !== 'started' || !branch) {
    return null;
  }
  const worktrees = (facts.worktrees.get((item.repo ?? '').toLowerCase()) ?? [])
    .filter((tree) => tree.branch === branch)
    .map((tree) => ({ path: tree.path, name: path.basename(tree.path) }));
  const sessions = facts.sessions
    .filter(
      (session) =>
        (item.repo ? sameRepo(session.repo, item.repo) : !session.repo) &&
        (session.branch === branch || worktrees.some((tree) => insideOf(session.cwd, tree.path))),
    )
    .map((session) => ({ id: session.id, title: session.title }));
  const starter = (item.started_by ?? '').toLowerCase();
  const folder = `-worktrees/${branch}`;
  // names a subagent given the work's folder or branch would carry
  const named = new Set(
    [...worktrees.map((tree) => tree.name), branch.split('/').pop() ?? ''].map((name) =>
      name.toLowerCase(),
    ),
  );
  const agent = newest(
    facts.agents.filter(
      (one) =>
        (!!starter && one.name.toLowerCase() === starter) ||
        named.has(one.name.toLowerCase()) ||
        claims(one, item.id) ||
        (!!one.task &&
          new RegExp(`${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./-])`).test(
            one.task,
          )),
    ),
  );
  const merged = facts.merged(item.repo, branch);
  const linked = worktrees.length > 0 || sessions.length > 0 || !!agent;
  return {
    worktrees,
    sessions,
    agent: agent ? agentLink(agent, facts) : null,
    merged: !!merged,
    merged_at: merged?.at ? new Date(merged.at).toISOString() : null,
    active: linked && !merged,
    branch: null,
  };
}
