/** Read-only git calls for local mode: rev-parse, the branch name and the diff. */
import { execFileSync } from 'node:child_process';
import type { LocalCommit } from '@once-upon-a-diff/shared/types';

/** Runs git in a checkout and returns stdout (throws on a non-zero exit). */
export const runGit = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const revParse = (repo: string, ref: string): string =>
  runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
export const topLevel = (repo: string): string =>
  runGit(repo, ['rev-parse', '--show-toplevel']).trim();

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
