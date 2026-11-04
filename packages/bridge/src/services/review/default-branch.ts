/** Whether a local story's commit has shipped to its checkout's default branch, asked through git. */
import { runGitAsync } from '../../adapters/git.ts';

/**
 * Whether a commit is already in the checkout's default branch (origin's, as last fetched): the commit is the branch's tip
 * or behind it. False when the ref or the commit is missing (git answers 128), so a story is never done by a guess.
 */
export async function inDefaultBranch(
  checkout: string,
  oid: string,
  { rewrittenFrom = null }: { rewrittenFrom?: string | null } = {},
): Promise<boolean> {
  const named = await runGitAsync(
    checkout,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    {
      timeout: 10000,
    },
  );
  const refs =
    named.code === 0 && named.stdout.trim()
      ? [named.stdout.trim()]
      : ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of refs) {
    const { code } = await runGitAsync(checkout, ['merge-base', '--is-ancestor', oid, ref], {
      timeout: 10000,
    });
    if (code === 0) {
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
    const based = await runGitAsync(checkout, ['merge-base', '--is-ancestor', rewrittenFrom, ref], {
      timeout: 10000,
    });
    if (based.code !== 0) {
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
