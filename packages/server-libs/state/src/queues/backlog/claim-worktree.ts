/**
 * The worktree a claim names (`backlog claim ID --worktree PATH`): it is checked against `git worktree list` when given, and
 * only then (the author makes its worktree after the editor claims, so a claim with none says nothing about one). The path
 * itself must be a worktree's root, on the claim's branch, and a checkout of the card's repo.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { worktreeList } from '@once-upon-a-diff/adapters/git';
import { repoOfCheckout, sameRepo } from '@once-upon-a-diff/foundation/repos';
import { parseWorktreeEntries } from '../../records/worktrees/worktrees.ts';
import type { BacklogItem } from './types.ts';

const real = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** What is wrong with the path as the worktree of a card's work (its repo and branch, each checked when known), or null when nothing is. */
export function claimWorktreeProblem(
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

/** For `once-upon doctor`: each live claim whose worktree git no longer lists (removed, moved, or never made), one line each. */
export function claimWorktreeProblems(
  items: Pick<BacklogItem, 'id' | 'state' | 'landed_at' | 'claim'>[],
): string[] {
  return items.flatMap((item) => {
    const dir = item.claim?.worktree;
    if (!dir || item.state === 'dropped' || item.landed_at) {
      return [];
    }
    const problem = claimWorktreeProblem(dir);
    return problem ? [`${item.id}'s claim names a worktree that is gone: ${problem}`] : [];
  });
}
