/*
 * Push, for a local story whose commits go straight to the repo's default branch (a repo that keeps its notes or its
 * config on master, say) instead of through a pull request.
 *
 * Which button a story gets (shipMode): config.json's `ship` rules first ({"owner/name": "push" | "pr"}, globs allowed),
 * else by branch. A story on the default branch, or with no recorded branch (built a commit at a time) whose head is
 * on the default branch, gets Push. Any other branch gets Create pull request (./pull-request.ts).
 *
 * The push (pushApproved) is one fast-forward, `git push origin <sha>:refs/heads/<default>`, of the approved commit
 * from the story's checkout with the reviewer's own git login. It sends up to the approved commit and no further, so
 * commits made after Approve stay local, and it never forces. pushView looks first, read-only, and says why a push
 * can't go: nothing approved; the approved commit isn't on the local default branch; origin's copy has commits this
 * checkout doesn't (it fetches that branch first); or GitHub protects the branch or requires pull requests
 * (`gh api repos/<repo>/branches/<branch>`, whose `protected` flag says whether it is, and the
 * branch's active rulesets), in which case the box offers Create pull request. A protection answer gh can't give
 * stops a push too: it is never assumed open.
 */
import { FULL_SHA_RE } from '@once-upon-a-diff/protocol/domain/patterns';
import { homeDir, readSettings, shipRuleFor } from '../config/settings.ts';
import { storyRepo } from './meta.ts';
import { runGh } from '../config/gh.ts';
import {
  commitLogAsync,
  defaultBranchOf,
  isAncestor,
  isAncestorAsync,
  revParse,
  runGitAsync,
} from '../../adapters/git.ts';
import { readApproval, APPROVED_DAYS } from './approval.ts';
import type { PushView, ShipMode } from '@once-upon-a-diff/protocol/types';
import type { StoryStore } from './store.ts';
import type { StoryMeta } from './types.ts';
import { shortSha } from '@once-upon-a-diff/protocol/domain/text';

const FETCH_MS = 30000;
const PUSH_MS = 5 * 60 * 1000; // a pre-push hook may run checks
/** Ruleset rules that stop a straight push (or only let a pull request or a merge queue through). */
const BLOCKING_RULES = new Set(['pull_request', 'required_status_checks', 'merge_queue', 'update']);

/**
 * How the story ships: a `ship` rule for its repo, else by branch. On the default branch, or on no branch with its head
 * in the local default branch, it is Push; anything else is Create pull request.
 */
export function shipMode(meta: StoryMeta, home = homeDir()): ShipMode {
  const forced = shipRuleFor(storyRepo(meta), readSettings(home).ship);
  if (forced) {
    return forced;
  }
  const repoPath = meta.repo_path;
  const def = repoPath ? defaultBranchOf(repoPath) : null;
  if (!repoPath || !def) {
    return 'pr';
  }
  if (meta.branch) {
    return meta.branch === def ? 'push' : 'pr';
  }
  const head = meta.head_oid;
  return head && FULL_SHA_RE.test(head) && isAncestor(repoPath, head, `refs/heads/${def}`)
    ? 'push'
    : 'pr';
}

/** The approved commit to push: the story's approved.json, while it is under APPROVED_DAYS old. */
export function approvedFor(stories: StoryStore, id: string, now = Date.now()) {
  const found = readApproval(stories, id);
  const approvedMs = found ? Date.parse(found.at) : NaN;
  return found &&
    FULL_SHA_RE.test(found.head_oid) &&
    now - approvedMs <= APPROVED_DAYS * 24 * 3600 * 1000
    ? found
    : null;
}

/**
 * Whether GitHub protects the branch or requires pull requests into it. The branch's own answer says whether classic
 * protection is on (`protection.enabled`): anyone with read access can see it, where the protection rules (admin only) answer 404 to everyone else, even for
 * a protected branch. The rules are asked only to say why.
 */
export async function protectionOf(repo: string, branch: string): Promise<PushView['protection']> {
  const name = encodeURIComponent(branch);
  let reason: string | undefined;
  try {
    const info: { protected?: unknown; protection?: { enabled?: unknown } } = JSON.parse(
      await runGh(['api', `repos/${repo}/branches/${name}`]),
    );
    // `protected` is also true for a branch only a ruleset covers (rulesets are weighed below), so classic protection is
    // `protection.enabled`; an answer that doesn't say counts as protected
    if (info.protected === true && info.protection?.enabled !== false) {
      reason = `GitHub protects ${branch}`;
      try {
        const rules: { required_pull_request_reviews?: unknown } = JSON.parse(
          await runGh(['api', `repos/${repo}/branches/${name}/protection`]),
        );
        if (rules.required_pull_request_reviews) {
          reason = `GitHub's branch protection on ${branch} requires pull requests`;
        }
      } catch {
        /* the rules are admin-only: "protects" is all a reader can say */
      }
    } else if (typeof info.protected !== 'boolean') {
      throw new Error('its answer has no protected flag');
    }
  } catch (err) {
    return {
      state: 'unknown',
      reason: `Couldn't ask GitHub whether ${branch} is protected (${(err as Error).message})`,
    };
  }
  if (reason) {
    return { state: 'protected', reason };
  }
  // rulesets are separate from branch protection, and an active one can require pull requests as well
  try {
    const rules: unknown = JSON.parse(
      await runGh(['api', `repos/${repo}/rules/branches/${name}?per_page=100`]),
    );
    const blocking = (Array.isArray(rules) ? rules : []).find((rule) =>
      BLOCKING_RULES.has(String(rule?.type)),
    );
    if (blocking) {
      return {
        state: 'protected',
        reason: `A GitHub ruleset on ${branch} requires ${String(blocking.type).replace(/_/g, ' ')}`,
      };
    }
  } catch (err) {
    return {
      state: 'unknown',
      reason: `Couldn't ask GitHub for ${branch}'s rulesets (${(err as Error).message})`,
    };
  }
  return { state: 'open' };
}

/**
 * What a push of the approved commit would do, and why it can't when it can't. Read-only apart from the fetch of origin's
 * default branch (its remote-tracking ref). Nothing is pushed here.
 */
export async function pushView(
  meta: StoryMeta,
  approval: { head_oid: string; at: string } | null,
): Promise<PushView> {
  const repoPath = meta.repo_path as string;
  const repo = storyRepo(meta);
  const branch = defaultBranchOf(repoPath);
  const view: PushView = {
    repo,
    branch,
    approved_sha: approval?.head_oid ?? null,
    approved_at: approval?.at ?? null,
    later: 0,
    remote: { state: 'unreachable', sha: null },
    to_push: [],
    protection: { state: 'unknown' },
    blocker: null,
    pr_instead: false,
  };
  const stop = (blocker: string, prInstead = false): PushView => ({
    ...view,
    blocker,
    pr_instead: prInstead,
  });
  if (!repo) {
    return stop("This checkout's origin isn't a GitHub repo.");
  }
  if (!branch) {
    return stop("Couldn't tell which branch is origin's default: origin/HEAD isn't set here.");
  }
  if (!approval) {
    return stop('Approve the story first: a push sends only the commit you approved.');
  }
  const sha = approval.head_oid;
  let tip: string;
  try {
    tip = revParse(repoPath, `refs/heads/${branch}`);
  } catch {
    return stop(`${branch} isn't in this checkout.`);
  }
  if (!tip || !(await isAncestorAsync(repoPath, sha, tip))) {
    return stop(
      `The approved commit ${shortSha(sha)} isn't on this checkout's ${branch}, so there is nothing to push to it. Pushing happens only for commits on ${branch}.`,
    );
  }
  view.later = (await commitLogAsync(repoPath, `${sha}..${tip}`)).length;
  // the fetch refreshes origin/<branch> so the comparison below is against what GitHub has now
  const [fetched, protection] = await Promise.all([
    runGitAsync(
      repoPath,
      ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { timeout: FETCH_MS },
    ),
    protectionOf(repo, branch),
  ]);
  view.protection = protection;
  if (fetched.code !== 0) {
    const error = fetched.stderr.trim().split('\n')[0] || 'git fetch failed';
    view.remote = { state: 'unreachable', sha: null, error };
    return stop(`Couldn't reach origin: ${error}`);
  }
  let remoteSha = '';
  try {
    remoteSha = revParse(repoPath, `refs/remotes/origin/${branch}`);
  } catch {
    /* origin has no such branch */
  }
  if (!remoteSha) {
    view.remote = { state: 'missing', sha: null };
    return stop(`origin has no ${branch} to fast-forward.`);
  }
  if (remoteSha === sha) {
    view.remote = { state: 'same', sha: remoteSha };
  } else if (await isAncestorAsync(repoPath, remoteSha, sha)) {
    view.remote = { state: 'ahead', sha: remoteSha };
    view.to_push = await commitLogAsync(repoPath, `${remoteSha}..${sha}`);
  } else if (await isAncestorAsync(repoPath, sha, remoteSha)) {
    view.remote = { state: 'behind', sha: remoteSha };
  } else {
    view.remote = { state: 'diverged', sha: remoteSha };
    return stop(
      `GitHub's ${branch} has commits this checkout's doesn't, so a push would be refused. Pull them, then open this box again. It never force-pushes.`,
    );
  }
  if (protection.state === 'protected') {
    return stop(`${protection.reason}. Push is refused: use Create pull request.`, true);
  }
  if (protection.state === 'unknown') {
    return stop(`${protection.reason}. Push waits until GitHub can say.`);
  }
  if (view.remote.state === 'same' || view.remote.state === 'behind') {
    return stop(`${branch} on GitHub already has this commit: nothing to push.`);
  }
  return view;
}

/** git push origin <sha>:refs/heads/<branch>: a fast-forward of the approved commit, never forced. Resolves to git's lines; rejects with them on failure. */
export async function pushApproved(repoPath: string, branch: string, sha: string): Promise<string> {
  const pushed = await runGitAsync(repoPath, ['push', 'origin', `${sha}:refs/heads/${branch}`], {
    timeout: PUSH_MS,
  });
  const output = `${pushed.stdout}${pushed.stderr}`.trim();
  if (pushed.code !== 0) {
    throw new Error(output || 'git push failed');
  }
  return output;
}
