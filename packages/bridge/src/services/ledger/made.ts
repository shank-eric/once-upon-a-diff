/**
 * What a registered author made, from git, for one that finishes without saying (`agent finish` with no --commit,
 * --pr, --branch or --card). The registered branch's tip is recorded when the agent starts (the start event's `tip`);
 * at finish the branch counts as made when it still exists and its tip is no longer that one, including after a
 * fast-forward into main. With no recorded start tip (the branch did not exist yet, or the start predates the field)
 * there is no automatic result: the author passes `--commit`. The branch, not the registered cwd: that is the main
 * checkout, and a branch's ref is the same from any checkout. A cwd that is not a checkout of the agent's registered
 * repo is nothing to look at. Every git failure, a slow one included (GIT_TIMEOUT_MS: this runs inside the board's
 * Finish request), is "made nothing here", so registering and finishing never fail because of it.
 */
import { remoteNamed } from '../config/repos.ts';
import { runGit } from '../../adapters/git.ts';
import type { AgentResult } from './agent-types.ts';
import type { LedgerAgent } from './ledger.ts';

const GIT_TIMEOUT_MS = 3000;

type Registered = Pick<LedgerAgent, 'cwd' | 'branch' | 'repo' | 'tip'>;

/** The commit a local branch points at in a checkout of the agent's repo, or null (no such branch, folder or repo). */
export function branchTip(
  cwd: string | null | undefined,
  branch: string | null | undefined,
  repo?: string | null,
): string | null {
  if (!cwd || !branch) {
    return null;
  }
  try {
    if (repo) {
      // any host: a GitHub Enterprise or GitLab checkout registered with --repo counts too (this never reaches gh)
      if (
        !remoteNamed(
          runGit(cwd, ['remote', 'get-url', 'origin'], {
            quiet: true,
            timeoutMs: GIT_TIMEOUT_MS,
          }).trim(),
          repo,
        )
      ) {
        return null;
      }
    }
    return (
      runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
        quiet: true,
        timeoutMs: GIT_TIMEOUT_MS,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** The result for a run whose registered branch moved since it started, or null. */
export function madeOnBranch(agent: Registered): AgentResult | null {
  if (!agent.tip || !agent.branch) {
    return null;
  }
  const tip = branchTip(agent.cwd, agent.branch, agent.repo);
  return tip && tip !== agent.tip ? { commit: tip, branch: agent.branch } : null;
}
