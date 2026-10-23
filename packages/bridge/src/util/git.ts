// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/** Read-only git calls for local mode: rev-parse, the branch name and the diff. */
import { execFileSync } from 'node:child_process';

/** Runs git in a checkout and returns stdout (throws on a non-zero exit). */
export const runGit = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const revParse = (repo, ref) =>
  runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
export const topLevel = (repo) => runGit(repo, ['rev-parse', '--show-toplevel']).trim();

export function branchName(repo) {
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
export const diffText = (repo, baseOid, headOid, { ignoreWhitespace = false } = {}) =>
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

export function commitsBetween(repo, baseOid, headOid) {
  const out = runGit(repo, ['log', '--format=%H%x09%cI%x09%s', `${baseOid}..${headOid}`]).trim();
  return out
    ? out.split('\n').map((line) => {
        const [sha, committedAt, subject] = line.split('\t');
        return { sha, at: committedAt, subject };
      })
    : [];
}
