/*
 * git, through the CLI, in a checkout: rev-parse, the branch name, the diff and the commits, plus runGitAsync for the slow
 * ones that reach origin (ls-remote, and the push behind the page's Create pull request, in services/stories/pull-request.ts).
 */
import { execFile, execFileSync } from 'node:child_process';
import type { LocalCommit } from '@once-upon-a-diff/protocol/types';
import type { RunResult, Runner } from './os.ts';

/** What `runGit` can be told: a kill timeout (none when 0 or unset), stderr dropped, or text for git's stdin. */
export interface RunGitOptions {
  timeoutMs?: number;
  quiet?: boolean;
  input?: string;
}

/**
 * Runs git in a checkout and returns stdout, untrimmed (throws on a non-zero exit). stderr goes into the thrown error,
 * or nowhere with `quiet`. With `timeoutMs` a call that takes longer is killed and throws. `input` is piped to stdin.
 */
export const runGit = (repo: string, args: string[], options: RunGitOptions = {}): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: [
      options.input === undefined ? 'ignore' : 'pipe',
      'pipe',
      options.quiet ? 'ignore' : 'pipe',
    ],
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });

/** Flags on every git call the board makes: no fsmonitor daemon to wedge on, and no index lock taken by a status. */
export const GIT_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

/**
 * Runs git in a folder through an injected program runner (a test passes its own to count or hold up calls), with the
 * board's flags (GIT_FLAGS). Resolves like the runner does: never rejects, and says when it was killed at the limit.
 */
export const gitVia = (
  run: Runner,
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> => run('git', ['-C', cwd, ...GIT_FLAGS, ...args], timeoutMs);

/**
 * Runs git in a checkout without blocking the bridge: resolves to {code, stdout, stderr}, never rejects. It never
 * prompts (GIT_TERMINAL_PROMPT=0), so a missing credential fails instead of hanging.
 */
export function runGitAsync(
  repo: string,
  args: string[],
  { timeout = 20000 } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          code = typeof err.code === 'number' ? err.code : 1;
        }
        resolve({ code, stdout, stderr: stderr || (err ? err.message : '') });
      },
    );
  });
}

export const revParse = (repo: string, ref: string): string =>
  runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();

export const topLevel = (repo: string): string =>
  runGit(repo, ['rev-parse', '--show-toplevel']).trim();

/**
 * Makes origin/<branch> the branch's upstream, with no push (after a push of a sha, which sets none). Resolves to whether
 * git took it.
 */
export async function setUpstream(repo: string, branch: string): Promise<boolean> {
  const set = await runGitAsync(repo, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  return set.code === 0;
}

/** The best common ancestor of two refs, as a full sha (throws when they share none). */
export const mergeBase = (repo: string, first: string, second: string): string =>
  runGit(repo, ['merge-base', first, second]).trim();

/** The local branches whose tip is exactly this commit, sorted by name. */
export function branchesAt(repo: string, oid: string): string[] {
  return runGit(repo, ['for-each-ref', '--points-at', oid, '--format=%(refname)', 'refs/heads'])
    .split('\n')
    .map((line) => line.trim().replace(/^refs\/heads\//, ''))
    .filter(Boolean)
    .sort();
}

/**
 * The branch a ref names in the checkout: the current branch for HEAD, the ref itself when it is a local branch
 * (`feat/x` or `refs/heads/feat/x`). Any other ref (a sha of any length, a tag, a remote branch) names the local branch
 * whose tip it resolves to: the only one, else the checkout's current branch when HEAD is that commit, else none, and
 * `ambiguous` lists the branches that tied. Null too for a commit no branch points at.
 */
export function branchOfRef(
  repo: string,
  ref: string,
): { branch: string | null; ambiguous: string[] } {
  if (ref === 'HEAD') {
    return { branch: branchName(repo), ambiguous: [] };
  }
  const name = ref.replace(/^refs\/heads\//, '');
  try {
    runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return { branch: name, ambiguous: [] };
  } catch {
    // not a local branch: a commit may still be the tip of one
  }
  const oid = revParse(repo, ref);
  const tips = branchesAt(repo, oid);
  if (tips.length === 1) {
    return { branch: tips[0], ambiguous: [] };
  }
  const current = branchName(repo);
  if (tips.length > 1 && current && tips.includes(current) && revParse(repo, 'HEAD') === oid) {
    return { branch: current, ambiguous: [] };
  }
  return { branch: null, ambiguous: tips };
}

export function branchName(repo: string): string | null {
  try {
    return runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/**
 * The diff between two commits, as `git diff base head` prints it (renames found, no colour, no external diff tools).
 * `ignoreWhitespace` adds -w (--ignore-all-space), GitHub's "Hide whitespace": a file whose only changes are whitespace drops out.
 */
export const diffText = (
  repo: string,
  baseOid: string,
  headOid: string,
  { ignoreWhitespace = false } = {},
): string =>
  runGit(repo, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
    baseOid,
    headOid,
  ]);

const LOG_FORMAT = '--format=%H%x09%cI%x09%s';

/** The commits in `git log --format=%H%x09%cI%x09%s` output (LOG_FORMAT), one per line; none for blank output. */
export function parseCommitLog(text: string): LocalCommit[] {
  const trimmed = text.trim();
  return trimmed
    ? trimmed.split('\n').map((line) => {
        const [sha, committedAt, subject] = line.split('\t');
        return { sha, at: committedAt, subject };
      })
    : [];
}

export const commitsBetween = (repo: string, baseOid: string, headOid: string): LocalCommit[] =>
  parseCommitLog(runGit(repo, ['log', LOG_FORMAT, `${baseOid}..${headOid}`]));

/** The commits `git log` lists for a range (as `[a..b]`, or `[head, '--not', '--remotes=origin']`); none when git fails. */
export function commitLog(repo: string, range: string[]): LocalCommit[] {
  try {
    return parseCommitLog(runGit(repo, ['log', LOG_FORMAT, ...range]));
  } catch {
    return [];
  }
}

/** commitLog without blocking the bridge: the commits of one range string, none when git exits non-zero. */
export async function commitLogAsync(repo: string, range: string): Promise<LocalCommit[]> {
  const log = await runGitAsync(repo, ['log', LOG_FORMAT, range]);
  return log.code === 0 ? parseCommitLog(log.stdout) : [];
}

/** Whether `ancestor` is the same commit as `descendant` or behind it (false when git can't say, a missing ref included). */
export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    runGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** isAncestor without blocking the bridge, with runGitAsync's 20 s limit unless told another. */
export async function isAncestorAsync(
  repo: string,
  ancestor: string,
  descendant: string,
  timeout?: number,
): Promise<boolean> {
  const checked = await runGitAsync(repo, ['merge-base', '--is-ancestor', ancestor, descendant], {
    timeout,
  });
  return checked.code === 0;
}

/**
 * origin's copy of a branch, asked of origin itself (no fetch): its sha, or null when origin has no such branch. `ok` is
 * false, with git's first line of complaint, when origin can't be reached.
 */
export async function remoteBranchSha(
  repo: string,
  branch: string,
  timeout?: number,
): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
  const listed = await runGitAsync(
    repo,
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    {
      timeout,
    },
  );
  if (listed.code !== 0) {
    return { ok: false, error: listed.stderr.trim().split('\n')[0] || 'git ls-remote failed' };
  }
  return { ok: true, sha: listed.stdout.trim().split(/\s+/)[0] || null };
}

/** branchName without blocking the bridge: the current branch, null when HEAD is detached or the folder isn't a repo. */
export async function branchNameAsync(repo: string, timeout?: number): Promise<string | null> {
  const out = await runGitAsync(repo, ['symbolic-ref', '--short', 'HEAD'], { timeout });
  return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

/** origin's default branch: from refs/remotes/origin/HEAD, else main or master when origin has one, else null. */
export function defaultBranchOf(repo: string): string | null {
  try {
    const named = runGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      .trim()
      .replace(/^origin\//, '');
    if (named) {
      return named;
    }
  } catch {
    /* origin/HEAD isn't set: look for the usual names */
  }
  for (const name of ['main', 'master']) {
    try {
      if (revParse(repo, `refs/remotes/origin/${name}`)) {
        return name;
      }
    } catch {
      /* not there */
    }
  }
  return null;
}

/** The URL of the checkout's `origin` remote (throws when there is none). */
export const remoteUrl = (dir: string): string =>
  runGit(dir, ['remote', 'get-url', 'origin'], { quiet: true });

/** The full sha of a commit the checkout has (a short sha, a ref), or null when it is not one of this repo's. */
export function commitOf(repo: string, ref: string): string | null {
  try {
    return runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

/** The commits reachable from `until` and not from `since`, as `git rev-list since..until` lists them (merges left out when asked). */
export function commitsInRange(
  repo: string,
  since: string,
  until: string,
  { merges = true } = {},
): string[] {
  return runGit(repo, ['rev-list', ...(merges ? [] : ['--no-merges']), `${since}..${until}`])
    .split('\n')
    .filter(Boolean);
}

/**
 * A commit's author, author date and message, which a cherry-pick keeps: equal for a commit and its pick, whatever the
 * patch looks like after a conflict-free but context-changing pick. Null for a commit that cannot be read.
 */
export function authorStamp(repo: string, sha: string): string | null {
  try {
    return runGit(repo, ['show', '-s', '--format=%an%x00%ae%x00%at%x00%B', sha]);
  } catch {
    return null;
  }
}

/**
 * The commit's patch-id (`git patch-id --stable` of its diff against its parent): equal for two commits that make the
 * same change, whatever their sha. Null for a commit with no patch (an empty commit or a merge), so two of those are never
 * taken for the same change.
 */
export function patchId(repo: string, sha: string): string | null {
  const diff = runGit(repo, ['diff-tree', '--root', '-p', '--no-color', '--no-ext-diff', sha]);
  if (!diff.trim()) {
    return null;
  }
  const out = runGit(repo, ['patch-id', '--stable'], { input: diff, quiet: true }).trim();
  return out.split(/\s+/)[0] || null;
}
