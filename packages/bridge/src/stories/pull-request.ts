/*
 * Create pull request, for a local story's branch. A session hands over the PR's title and body with
 * `once-upon pr-draft` (kept as the story's pr-draft.json). The page's button asks where the branch stands on
 * GitHub (prView), and on the reviewer's own click in its confirm box pushes it (pushBranch), then opens GitHub's
 * compare page with the title and body filled in. The PR itself is made there, by the reviewer: nothing here runs
 * `gh pr create`, and gh is only asked (read-only) whether the branch already has an open PR.
 *
 * The push is a plain `git push -u origin <branch>` with the reviewer's own git login. It never forces: a branch
 * whose GitHub copy has commits this checkout doesn't is reported as diverged and not pushed.
 */
import { runGh } from '../util/gh.ts';
import { revParse, runGit, runGitAsync } from '../util/git.ts';
import { storyRepo } from '../config/repos.ts';
import type { LocalCommit, PrDraft, PrView } from '@once-upon-a-diff/shared/types';
import type { StoryMeta } from '../types.ts';

export const DRAFT_FILE = 'pr-draft.json';
const LS_REMOTE_MS = 20000;
const PUSH_MS = 5 * 60 * 1000; // a pre-push hook may run checks
const FULL_SHA = /^[0-9a-f]{40}$/;
const LOG_FORMAT = '--format=%H%x09%cI%x09%s';

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
  if (!base || FULL_SHA.test(base)) {
    return null;
  }
  const name = base.replace(/^refs\/remotes\/origin\/|^refs\/heads\/|^origin\//, '');
  return hasRemoteBranch(repoPath, name) ? name : null;
}

/** origin's default branch, from refs/remotes/origin/HEAD, else main. */
function defaultBranch(repoPath: string): string {
  try {
    return runGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      .trim()
      .replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

function commitsOf(repoPath: string, range: string[]): LocalCommit[] {
  try {
    const text = runGit(repoPath, ['log', LOG_FORMAT, ...range]).trim();
    return text
      ? text.split('\n').map((line) => {
          const [sha, committedAt, subject] = line.split('\t');
          return { sha, at: committedAt, subject };
        })
      : [];
  } catch {
    return [];
  }
}

/** Where origin's copy of the branch stands against the local one, and what a push would send. */
async function remoteOf(
  repoPath: string,
  branch: string,
  headSha: string,
): Promise<Pick<PrView, 'remote' | 'to_push'>> {
  const listed = await runGitAsync(
    repoPath,
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { timeout: LS_REMOTE_MS },
  );
  if (listed.code !== 0) {
    const error = listed.stderr.trim().split('\n')[0] || 'git ls-remote failed';
    return { remote: { state: 'unreachable', sha: null, error }, to_push: [] };
  }
  const remoteSha = listed.stdout.trim().split(/\s+/)[0] || null;
  if (!remoteSha) {
    // not on GitHub yet: the push sends what no origin branch has
    const toPush = commitsOf(repoPath, [headSha, '--not', '--remotes=origin']);
    return { remote: { state: 'missing', sha: null }, to_push: toPush };
  }
  if (remoteSha === headSha) {
    return { remote: { state: 'same', sha: remoteSha }, to_push: [] };
  }
  const ancestor = await runGitAsync(repoPath, ['merge-base', '--is-ancestor', remoteSha, headSha]);
  if (ancestor.code !== 0) {
    // not an ancestor, or a commit this checkout hasn't fetched: a plain push would be refused
    return { remote: { state: 'diverged', sha: remoteSha }, to_push: [] };
  }
  return {
    remote: { state: 'ahead', sha: remoteSha },
    to_push: commitsOf(repoPath, [`${remoteSha}..${headSha}`]),
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

/** git push -u origin <branch>: never forced. Resolves to git's own lines; rejects with them when it fails. */
export async function pushBranch(repoPath: string, branch: string): Promise<string> {
  const pushed = await runGitAsync(
    repoPath,
    ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
    { timeout: PUSH_MS },
  );
  const output = `${pushed.stdout}${pushed.stderr}`.trim();
  if (pushed.code !== 0) {
    throw new Error(output || 'git push failed');
  }
  return output;
}
