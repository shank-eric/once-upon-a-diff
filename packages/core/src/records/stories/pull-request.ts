/*
 * Create pull request, for a local story's branch. A session hands over the PR's title and body with
 * `once-upon pr-draft` (kept as the story's pr-draft.json). The page's button asks where the branch stands on
 * GitHub (prView), and on the reviewer's own click in its confirm box pushes it (pushBranch), then opens GitHub's
 * compare page with the title and body filled in. The PR itself is made there, by the reviewer: nothing here runs
 * `gh pr create`, and gh is only asked (read-only) whether the branch already has an open PR.
 *
 * The push is a plain `git push -u origin <branch>` with the reviewer's own git login. It never forces: a branch
 * whose GitHub copy has commits this checkout doesn't is reported as diverged and not pushed.
 *
 * Push for a branch that already has an open PR (a fix made after review): aheadOf counts the local commits origin's
 * copy lacks (`git ls-remote` and `git rev-list --count`, no fetch), and pushAhead sends them with a plain
 * `git push origin <branch>`, a fast-forward that never forces and is refused when origin has commits this checkout
 * doesn't (pushAheadBlocker).
 */
import { FULL_SHA_RE } from '@once-upon-a-diff/domain/patterns';
import { runGh } from '../../foundation/gh.ts';
import {
  commitLog,
  defaultBranchOf,
  isAncestorAsync,
  remoteBranchSha,
  revParse,
  runGitAsync,
  setUpstream,
} from '../../adapters/git.ts';
import { storyRepo } from './meta.ts';
import type { PrDraft, PrView } from '@once-upon-a-diff/contracts/types';
import type { StoryMeta } from './types.ts';

export const DRAFT_FILE = 'pr-draft.json';
const LS_REMOTE_MS = 20000;
const PUSH_MS = 5 * 60 * 1000; // a pre-push hook may run checks

/** A git ref for this checkout's branch, or null when it has none. */
function headOf(repoPath: string, branch: string): string | null {
  try {
    return revParse(repoPath, `refs/heads/${branch}`) || null;
  } catch {
    return null;
  }
}

function hasRemoteBranch(repoPath: string, name: string): boolean {
  try {
    return !!revParse(repoPath, `refs/remotes/origin/${name}`);
  } catch {
    return false;
  }
}

/** The story's base as a branch on origin (origin/develop, develop), or null for a commit or an expression. */
export function namedBase(repoPath: string, base: string | undefined): string | null {
  if (!base || FULL_SHA_RE.test(base)) {
    return null;
  }
  const name = base.replace(/^refs\/remotes\/origin\/|^refs\/heads\/|^origin\//, '');
  return hasRemoteBranch(repoPath, name) ? name : null;
}

/** origin's default branch (as Push finds it), else main. */
function defaultBranch(repoPath: string): string {
  return defaultBranchOf(repoPath) || 'main';
}

/** Where origin's copy of the branch stands against the local one, and what a push would send. */
async function remoteOf(
  repoPath: string,
  branch: string,
  headSha: string,
): Promise<Pick<PrView, 'remote' | 'to_push'>> {
  const listed = await remoteBranchSha(repoPath, branch, LS_REMOTE_MS);
  if (!listed.ok) {
    return { remote: { state: 'unreachable', sha: null, error: listed.error }, to_push: [] };
  }
  const remoteSha = listed.sha;
  if (!remoteSha) {
    // not on GitHub yet: the push sends what no origin branch has
    const toPush = commitLog(repoPath, [headSha, '--not', '--remotes=origin']);
    return { remote: { state: 'missing', sha: null }, to_push: toPush };
  }
  if (remoteSha === headSha) {
    return { remote: { state: 'same', sha: remoteSha }, to_push: [] };
  }
  if (!(await isAncestorAsync(repoPath, remoteSha, headSha))) {
    // not an ancestor, or a commit this checkout hasn't fetched: a plain push would be refused
    return { remote: { state: 'diverged', sha: remoteSha }, to_push: [] };
  }
  return {
    remote: { state: 'ahead', sha: remoteSha },
    to_push: commitLog(repoPath, [`${remoteSha}..${headSha}`]),
  };
}

/** The branch's open PR, from a read-only gh call, or null (none, or gh couldn't say). */
async function openPull(repo: string, branch: string): Promise<PrView['pull']> {
  try {
    const text = await runGh([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url',
      '--limit',
      '1',
    ]);
    const found = JSON.parse(text) as { number: number; url: string }[];
    return found.length ? { number: found[0].number, url: found[0].url } : null;
  } catch {
    return null;
  }
}

/** Where a local story's branch stands, for the page's Create pull request box. */
export async function prView(meta: StoryMeta, draft: PrDraft | null): Promise<PrView> {
  const repoPath = meta.repo_path as string;
  const repo = storyRepo(meta);
  const branch = meta.branch || null;
  const base = (draft && draft.base) || namedBase(repoPath, meta.base) || defaultBranch(repoPath);
  const headSha = branch ? headOf(repoPath, branch) : null;
  const view: PrView = {
    repo,
    branch,
    base,
    head_sha: headSha,
    remote: { state: 'unreachable', sha: null },
    to_push: [],
    draft,
    pull: null,
  };
  if (!branch || !headSha) {
    view.remote.error = branch
      ? `the branch ${branch} isn't in this checkout any more`
      : 'the story was made on a detached HEAD, so it has no branch to open a PR from';
    return view;
  }
  const [remote, pull] = await Promise.all([
    remoteOf(repoPath, branch, headSha),
    repo ? openPull(repo, branch) : Promise.resolve(null),
  ]);
  return { ...view, ...remote, pull };
}

/** Why a push can't go ahead, or null when it can. expectedSha is the commit the confirm box showed. */
export function pushBlocker(view: PrView, expectedSha: unknown): string | null {
  if (!view.branch || !view.head_sha) {
    return view.remote.error || 'no branch to push';
  }
  if (expectedSha !== view.head_sha) {
    return `${view.branch} moved since the box opened. Look again before pushing.`;
  }
  if (view.remote.state === 'diverged') {
    return `GitHub's ${view.branch} has commits this checkout doesn't, so a push would be refused. Pull them first.`;
  }
  if (view.remote.state === 'unreachable') {
    return `Couldn't reach origin: ${view.remote.error}`;
  }
  return null;
}

/**
 * The push of a branch to origin, never forced: the branch ref with `-u`, or with `sha` exactly that commit
 * (`<sha>:refs/heads/<branch>`, a storyless review's shown head), so a commit made since the check can't go out with it.
 * A sha has no local branch to track, so the push sets no upstream: pushWith sets it after.
 */
export function branchPushArgs(branch: string, sha: string | null, upstream: boolean): string[] {
  if (sha) {
    return ['push', 'origin', `${sha}:refs/heads/${branch}`];
  }
  return [
    'push',
    ...(upstream ? ['-u'] : []),
    'origin',
    `refs/heads/${branch}:refs/heads/${branch}`,
  ];
}

/** git push -u origin <branch> (or `sha` only: branchPushArgs): never forced. Resolves to git's own lines; rejects with them when it fails. */
export async function pushBranch(
  repoPath: string,
  branch: string,
  sha: string | null = null,
): Promise<string> {
  return pushWith(repoPath, branch, sha, true);
}

/**
 * Runs the push. After a sha push it makes origin/<branch> the branch's upstream, with no push, as `-u` would have: the
 * fix-round relay tells an author that a branch with an upstream holding its tip is pushed (new commit, not an amend).
 */
async function pushWith(
  repoPath: string,
  branch: string,
  sha: string | null,
  upstream: boolean,
): Promise<string> {
  const pushed = await runGitAsync(repoPath, branchPushArgs(branch, sha, upstream), {
    timeout: PUSH_MS,
  });
  const output = `${pushed.stdout}${pushed.stderr}`.trim();
  if (pushed.code !== 0) {
    throw new Error(output || 'git push failed');
  }
  if (sha) {
    await setUpstream(repoPath, branch);
  }
  return output;
}

/**
 * How many commits the local branch has that origin's copy lacks, from `git ls-remote` and `git rev-list --count`
 * without fetching: 0 when they match, null when it can't be said (origin unreachable, no such branch there or here, or
 * origin's copy has commits this checkout doesn't, which a push would be refused over).
 */
export async function aheadOf(repoPath: string, branch: string): Promise<number | null> {
  const headSha = headOf(repoPath, branch);
  if (!headSha) {
    return null;
  }
  const listed = await remoteBranchSha(repoPath, branch, LS_REMOTE_MS);
  const remoteSha = listed.ok ? listed.sha : null;
  if (!remoteSha) {
    return null;
  }
  if (remoteSha === headSha) {
    return 0;
  }
  if (!(await isAncestorAsync(repoPath, remoteSha, headSha))) {
    return null;
  }
  const counted = await runGitAsync(repoPath, ['rev-list', '--count', `${remoteSha}..${headSha}`]);
  const count = Number(counted.stdout.trim());
  return counted.code === 0 && Number.isInteger(count) ? count : null;
}

/** Why a push of an open PR's branch can't go ahead, or null when it can. expectedSha is the commit the box showed. */
export function pushAheadBlocker(view: PrView, expectedSha: unknown): string | null {
  if (!view.pull) {
    return `${view.branch || 'This branch'} has no open PR here: use Create pull request.`;
  }
  const blocker = pushBlocker(view, expectedSha);
  if (blocker) {
    return view.remote.state === 'diverged'
      ? `GitHub's ${view.branch} has commits this checkout doesn't, so a push would be refused. Pull first.`
      : blocker;
  }
  if (view.remote.state === 'missing') {
    return `origin has no ${view.branch}: use Create pull request.`;
  }
  if (view.remote.state === 'same') {
    return `${view.branch} is on GitHub and up to date: nothing to push.`;
  }
  return null;
}

/** git push origin <branch>: a fast-forward of the branch, never forced. Resolves to git's own lines; rejects with them when it fails. */
export async function pushAhead(
  repoPath: string,
  branch: string,
  sha: string | null = null,
): Promise<string> {
  return pushWith(repoPath, branch, sha, false);
}
