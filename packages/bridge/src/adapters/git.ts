/*
 * git, through the CLI, in a checkout: rev-parse, the branch name, the diff and the commits, plus runGitAsync for the slow
 * ones that reach origin (ls-remote, and the push behind the page's Create pull request, in services/stories/pull-request.ts).
 */
import { execFile, execFileSync } from 'node:child_process';
import type { LocalCommit } from '@once-upon-a-diff/protocol/types';

/**
 * Runs git in a folder and returns its trimmed stdout (throws on a non-zero exit, and says nothing on stderr). With
 * `timeoutMs` a call that takes longer is killed and throws.
 */
export const gitText = (dir: string, args: string[], timeoutMs?: number): string =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }).trim();

/** Runs git in a checkout and returns stdout (throws on a non-zero exit). */
export const runGit = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

export function commitsBetween(repo: string, baseOid: string, headOid: string): LocalCommit[] {
  const out = runGit(repo, ['log', '--format=%H%x09%cI%x09%s', `${baseOid}..${headOid}`]).trim();
  return out
    ? out.split('\n').map((line) => {
        const [sha, committedAt, subject] = line.split('\t');
        return { sha, at: committedAt, subject };
      })
    : [];
}

/** The URL of the checkout's `origin` remote (throws when there is none). */
export const remoteUrl = (dir: string): string =>
  execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

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
 * The commit's patch-id (`git patch-id --stable` of its diff against its parent): equal for two commits that make the
 * same change, whatever their sha. Null for a commit with no patch (an empty commit or a merge), so two of those are never
 * taken for the same change.
 */
export function patchId(repo: string, sha: string): string | null {
  const diff = runGit(repo, ['diff-tree', '--root', '-p', '--no-color', '--no-ext-diff', sha]);
  if (!diff.trim()) {
    return null;
  }
  const out = execFileSync('git', ['-C', repo, 'patch-id', '--stable'], {
    encoding: 'utf8',
    input: diff,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  return out.split(/\s+/)[0] || null;
}
