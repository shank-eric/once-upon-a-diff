/**
 * Whether a path is the worktree of a card's work: git lists it (`git worktree list`), it is the root of one, on the card's
 * branch, and a checkout of the card's repo. `dispatch` checks a fixer's worktree with it (the one it verified becomes the
 * card's, ADR-29), and `once-upon doctor` checks the worktree an open run's card is linked to.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { worktreeList } from '@once-upon-a-diff/adapters/git';
import { repoOfCheckout, sameRepo } from '@once-upon-a-diff/foundation/repos';
import { parseWorktreeEntries } from '../../records/worktrees/worktrees.ts';
import { runIsOpen } from '../../records/agents/events.ts';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import { workAgent } from './phase.ts';
import type { BacklogItem } from './types.ts';

const real = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** What is wrong with the path as the worktree of a card's work (its repo and branch, each checked when known), or null when nothing is. */
export function worktreeProblem(
  dir: string,
  want: { repo?: string | null; branch?: string | null } = {},
): string | null {
  const here = real(dir);
  let listed: ReturnType<typeof parseWorktreeEntries>;
  try {
    listed = parseWorktreeEntries(worktreeList(here));
  } catch {
    return `${dir} is not a git worktree (git worktree list does not know it)`;
  }
  const entry = listed.find((one) => real(one.path) === here);
  if (!entry) {
    return `${dir} is inside a worktree but is not the root of one: pass the worktree's own folder`;
  }
  if (want.branch && entry.branch !== want.branch) {
    return `${dir} has ${entry.branch ?? 'a detached HEAD'} checked out, not ${want.branch}`;
  }
  const repo = repoOfCheckout(here);
  if (want.repo && repo && !sameRepo(repo, want.repo)) {
    return `${dir} is a checkout of ${repo}, not ${want.repo}`;
  }
  return null;
}

/** For `once-upon doctor`: each card with an open work run whose linked worktree git no longer lists (removed, moved, or never made), one line each. */
export function openRunWorktreeProblems(
  items: Pick<BacklogItem, 'id' | 'state' | 'landed_at' | 'worktree'>[],
  agents: LedgerAgent[],
): string[] {
  return items.flatMap((item) => {
    const run = workAgent(item, agents);
    if (!item.worktree || item.state === 'dropped' || item.landed_at || !run || !runIsOpen(run)) {
      return [];
    }
    const problem = worktreeProblem(item.worktree);
    return problem ? [`${item.id}'s run ${run.name} has a worktree that is gone: ${problem}`] : [];
  });
}
