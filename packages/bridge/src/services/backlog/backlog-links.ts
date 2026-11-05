/**
 * What a started backlog item is being worked by, found from three places (the `start` event only says a branch and
 * who started it, `by`):
 *
 *   worktrees   any git worktree on that branch, in the checkouts the board knows for the item's repo
 *   sessions    any live session on that branch, or working inside such a worktree
 *   agent       the ledger agent that holds the item's claim (`once-upon backlog claim`, claims.ts), with its latest
 *               progress beat. Never guessed from `by`, a worktree folder's name or the agent's task text
 *
 * and whether the branch's work has merged. An open item with a claim is linked by the agent alone (`agentLinks`). The
 * one place for those rules. Pure: board.ts gathers the facts.
 */
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';
import type { BoardBeat, BoardStartedLinks } from '@once-upon-a-diff/contracts/types';
import { parseWorktreeEntries } from '../worktrees/worktrees.ts';
import { beatOf } from '../ledger/events.ts';
import type { LedgerAgent } from '../ledger/ledger.ts';
import type { BacklogItem } from './types.ts';
import { OPEN, claimedAgent } from './claims.ts';

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

/** The link for an open item with a claimed agent: the agent only (a branch comes with a `start`, which `claim --branch` writes). */
export function agentLinks(
  item: BacklogItem,
  facts: Pick<LinkFacts, 'agents' | 'beats'>,
): BoardStartedLinks | null {
  const agent = item.state === 'open' ? claimedAgent(item, facts.agents) : null;
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
  };
}

function agentLink(
  agent: LedgerAgent,
  facts: Pick<LinkFacts, 'beats'>,
): NonNullable<BoardStartedLinks['agent']> {
  return {
    name: agent.name,
    state: agent.state,
    beat: beatOf(agent, facts.beats) ?? null,
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
  const agent = claimedAgent(item, facts.agents);
  const merged = facts.merged(item.repo, branch);
  const linked = worktrees.length > 0 || sessions.length > 0 || !!agent;
  return {
    worktrees,
    sessions,
    agent: agent ? agentLink(agent, facts) : null,
    merged: !!merged,
    merged_at: merged?.at ? new Date(merged.at).toISOString() : null,
    active: linked && !merged,
  };
}
