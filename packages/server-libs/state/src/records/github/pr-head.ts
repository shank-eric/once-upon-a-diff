/** A PR's head branch, for a run started with `--pr N` and no branch (agent start). One gh call, with a short timeout: a start must not hang. */
import { runGh } from '@once-upon-a-diff/foundation/gh';

/** The branch the PR is made from; null when gh answers without one. Rejects with gh's first error line. */
export async function prHeadBranch(repo: string, number: number): Promise<string | null> {
  const body = JSON.parse(
    await runGh(['api', `repos/${repo}/pulls/${number}`], { timeout: 15000 }),
  );
  const ref = body?.head?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}
