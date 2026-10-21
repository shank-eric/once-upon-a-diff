/** Read-only git calls for local mode: rev-parse, the branch name and the diff. */
import { execFileSync } from 'node:child_process';

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export const revParse = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
export const topLevel = repo => git(repo, ['rev-parse', '--show-toplevel']).trim();

export function branchName(repo) {
  try { return git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { return null; }
}

/**
 * The diff between two commits, as `git diff base head` prints it (renames found, no colour, no external diff tools).
 * `ignoreWhitespace` adds -w (--ignore-all-space), GitHub's "Hide whitespace": a file whose only changes are whitespace drops out.
 */
export const diffText = (repo, baseOid, headOid, { ignoreWhitespace = false } = {}) => git(repo, [
  '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', ...(ignoreWhitespace ? ['--ignore-all-space'] : []), baseOid, headOid,
]);

export function commitsBetween(repo, baseOid, headOid) {
  const out = git(repo, ['log', '--format=%H%x09%cI%x09%s', `${baseOid}..${headOid}`]).trim();
  return out ? out.split('\n').map(l => { const [sha, at, subject] = l.split('\t'); return { sha, at, subject }; }) : [];
}
