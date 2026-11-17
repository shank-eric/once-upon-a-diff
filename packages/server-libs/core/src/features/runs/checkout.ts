/*
 * Where a card's work lives on disk, from git: the repo's main checkout (the first of `git worktree list`), its default branch,
 * and the worktree and notes-file paths the rules give a branch (`../<repo>-worktrees/<branch>`, `<branch>.notes.md` beside it).
 */
import path from 'node:path';
import { commitOf, defaultBranchOf, worktreeList } from '@once-upon-a-diff/adapters/git';
import { slug } from '@once-upon-a-diff/terms/ids';
import { parseWorktreeEntries } from '@once-upon-a-diff/state/records/worktrees/worktrees';

/** The repo's main checkout, found from any of its worktrees or subfolders (the folder itself when git cannot say). */
export function mainCheckout(dir: string): string {
  try {
    return parseWorktreeEntries(worktreeList(dir))[0]?.path ?? dir;
  } catch {
    return dir;
  }
}

/** The repo's default branch: origin's when this checkout has it, else main or master, else `main`. */
export function defaultBranch(repo: string): string {
  const named = defaultBranchOf(repo);
  for (const name of [named, 'main', 'master']) {
    if (name && commitOf(repo, `refs/heads/${name}`)) {
      return name;
    }
  }
  return named ?? 'main';
}

/** A branch's folder and run name: `feat/x` is `feat-x` (the terms package's slug). */
export const flat = (branch: string): string => slug(branch);

/** Where a branch's worktree and notes file go, next to the main checkout. */
export function workPaths(main: string, branch: string): { worktree: string; notes: string } {
  const trees = path.join(path.dirname(main), `${path.basename(main)}-worktrees`);
  return {
    worktree: path.join(trees, flat(branch)),
    notes: path.join(trees, `${flat(branch)}.notes.md`),
  };
}
