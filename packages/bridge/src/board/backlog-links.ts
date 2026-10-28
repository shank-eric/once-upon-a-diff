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
 * and whether the branch's work has merged. The one place for those rules. Pure: board.ts gathers the facts.
 */
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';
import type { BoardBeat, BoardStartedLinks } from '@once-upon-a-diff/shared/types';
import type { LedgerAgent } from './ledger.ts';
import type { BacklogItem } from './backlog.ts';

/** One checkout of a repo, as `git worktree list --porcelain` gives it. */
export interface Worktree {
  path: string;
  /** the branch checked out there, null when detached */
  branch: string | null;
}

/** The worktrees in `git worktree list --porcelain` output: blocks of `worktree <path>`, `HEAD ...`, `branch refs/heads/<name>`. */
export function parseWorktrees(text: string): Worktree[] {
  const found: Worktree[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const dir = lines.find((line) => line.startsWith('worktree '));
    if (!dir) {
      continue;
    }
    const branch = lines.find((line) => line.startsWith('branch '));
    found.push({
      path: dir.slice('worktree '.length).trim(),
      branch: branch
        ? branch
            .slice('branch '.length)
            .trim()
            .replace(/^refs\/heads\//, '')
        : null,
    });
  }
  return found;
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
    agent: agent
      ? {
          name: agent.name,
          state: agent.state,
          beat: facts.beats.get(agent.name) ?? null,
          outcome: agent.outcome,
          ended_at: agent.ended ? agent.ended.toISOString() : null,
        }
      : null,
    merged: !!merged,
    merged_at: merged?.at ? new Date(merged.at).toISOString() : null,
    active: linked && !merged,
  };
}
