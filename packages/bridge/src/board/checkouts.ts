/**
 * Where a repo is checked out on this Mac, learned from what the board already sees instead of scanning folders for it:
 *
 *   sessions    the folders of live sessions (the repo is the session's origin)
 *   agents      the folders a ledger agent's task names (`<repo>-worktrees/<name>`, `~/Development/...`)
 *   seen        the checkouts the bridge has recorded (checkouts.json, a local story's checkout)
 *
 * Every candidate counts only when its own `git remote get-url origin` is the repo, so a folder named for one repo that
 * holds another, and a stale path, are left out. config.json's checkout_dirs is the fallback, used only when none of the
 * above found the repo. Pure apart from `isDir` and `repoOf`, which the board passes in.
 */
import os from 'node:os';
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';

/** Absolute and `~/` paths in free text (a ledger task): not a URL, a date or `and/or`; a trailing dot or comma is not part of one. */
export function pathsIn(text: string | null | undefined, home = os.homedir()): string[] {
  const found = new Set<string>();
  for (const match of String(text ?? '').matchAll(
    /(?<![\w/.~:-])(~?\/[\w.@+-]+(?:\/[\w.@+-]+)*)/g,
  )) {
    const raw = match[1].replace(/[.,;:]+$/, '');
    if (raw === '~' || raw.split('/').length < 3) {
      continue;
    }
    found.add(raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
  }
  return [...found];
}

export interface CheckoutFacts {
  /** the folders of live sessions */
  sessionDirs: string[];
  /** the tasks of the ledger agents worth looking at (open ones, and the lately finished) */
  agentTasks: (string | null)[];
  /** checkouts the bridge recorded */
  seenDirs: string[];
  /** the folder itself when it is one, else its parent for a file path, else null */
  dirOf: (candidate: string) => string | null;
  /** the repo a folder's origin points at */
  repoOf: (dir: string) => Promise<string | null>;
  /** checkout_dirs' answer: only asked when nothing else found the repo */
  fallback: () => string | null;
}

/** The folders of a repo's checkouts, learned from the facts; the fallback's only when there are none. */
export async function checkoutsOf(repo: string, facts: CheckoutFacts): Promise<string[]> {
  const candidates = new Set<string>(facts.sessionDirs);
  for (const task of facts.agentTasks) {
    for (const found of pathsIn(task)) {
      const dir = facts.dirOf(found);
      if (dir) {
        candidates.add(dir);
      }
    }
  }
  for (const dir of facts.seenDirs) {
    candidates.add(dir);
  }
  const checked = await Promise.all(
    [...candidates].map(async (dir) => sameRepo(await facts.repoOf(dir).catch(() => null), repo)),
  );
  const dirs = [...candidates].filter((_, index) => checked[index]);
  if (dirs.length) {
    return dirs;
  }
  const fallback = facts.fallback();
  return fallback ? [fallback] : [];
}
