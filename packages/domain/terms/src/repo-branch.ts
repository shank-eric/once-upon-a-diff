/*
 * Whether something names both a repo and a branch: a card, a work or a story that can be looked up by its branch. Pure, so the
 * board and the engine under it share the one test.
 */

/** A thing that may name a repo and a branch. */
export interface MaybeBranch {
  repo: string | null;
  branch: string | null;
}

/** Whether it names both a repo and a branch (a blank one counts as none). */
export function hasRepoAndBranch<T extends MaybeBranch>(
  thing: T,
): thing is T & { repo: string; branch: string } {
  return !!thing.repo && !!thing.branch;
}
