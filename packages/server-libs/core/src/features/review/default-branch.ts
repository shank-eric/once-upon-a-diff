/** Whether a local story's commit has shipped to its checkout's default branch, asked through git. */
import { defaultBranchOf, isAncestorAsync, runGitAsync } from '@once-upon-a-diff/adapters/git';

/**
 * Whether a commit is already in the checkout's default branch (origin's, as last fetched): the commit is the branch's tip
 * or behind it. False when the ref or the commit is missing (git answers 128), so a story is never done by a guess.
 */
export async function inDefaultBranch(
  checkout: string,
  oid: string,
  { rewrittenFrom = null }: { rewrittenFrom?: string | null } = {},
): Promise<boolean> {
  const name = defaultBranchOf(checkout); // the one rule Push and Create pull request use too
  if (!name) {
    return false;
  }
  const refs = [`refs/remotes/origin/${name}`];
  for (const ref of refs) {
    if (await isAncestorAsync(checkout, oid, ref, 10000)) {
      return true;
    }
  }
  // Commits pushed straight to the default branch after a rebase or amend are not the story's commit any more: its head
  // is in no ref, its base is in the default branch, and the checkout has nothing unpushed. Such a story's work shipped
  // under other ids, so it is delivered. Only a story with no branch of its own (`rewrittenFrom` is its base) is asked.
  if (!rewrittenFrom) {
    return false;
  }
  for (const ref of refs) {
    if (!(await isAncestorAsync(checkout, rewrittenFrom, ref, 10000))) {
      continue;
    }
    const held = await runGitAsync(
      checkout,
      ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', oid],
      { timeout: 10000 },
    );
    const unpushed = await runGitAsync(checkout, ['rev-list', '--count', `${ref}..HEAD`], {
      timeout: 10000,
    });
    return (
      held.code === 0 &&
      !held.stdout.trim() &&
      unpushed.code === 0 &&
      unpushed.stdout.trim() === '0'
    );
  }
  return false;
}
