import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { localRepo } from '@once-upon-a-diff/test-kit/git';
import {
  authorStamp,
  branchOfRef,
  commitLog,
  commitLogAsync,
  commitOf,
  commitsBetween,
  commitsInRange,
  diffText,
  isAncestor,
  isAncestorAsync,
  mergeBase,
  patchId,
  remoteBranchSha,
  revParse,
  setUpstream,
} from '../src/git.ts';

// a value that starts with `-` is a revision or a branch to git, never an option: `--output=<file>` would make it write there
const out = () => path.join(tmp('git-options'), 'written');

test('diffText never reads a base or head as an option', () => {
  const { repo, base } = localRepo();
  for (const [first, second] of [
    [`--output=${out()}`, 'HEAD'],
    [base, `--output=${out()}`],
  ]) {
    const file = (first.startsWith('--') ? first : second).slice('--output='.length);
    assert.throws(() => diffText(repo, first, second));
    assert.throws(() => diffText(repo, first, second, { ignoreWhitespace: true }));
    assert.equal(existsSync(file), false, 'git wrote the file the value named');
  }
  assert.match(diffText(repo, base, 'HEAD'), /^diff --git/m);
});

test('the other git helpers never read a ref, branch or sha as an option', async () => {
  const { repo, base } = localRepo();
  const file = out();
  const bad = `--output=${file}`;
  assert.throws(() => revParse(repo, bad));
  assert.equal(commitOf(repo, bad), null);
  assert.throws(() => mergeBase(repo, bad, 'HEAD'));
  assert.throws(() => mergeBase(repo, 'HEAD', bad));
  assert.throws(() => commitsBetween(repo, bad, 'HEAD'));
  assert.throws(() => commitsInRange(repo, bad, 'HEAD'));
  assert.deepEqual(commitLog(repo, [bad]), []);
  assert.deepEqual(commitLog(repo, [`${bad}..HEAD`]), []);
  assert.deepEqual(await commitLogAsync(repo, bad), []);
  assert.equal(isAncestor(repo, bad, 'HEAD'), false);
  assert.equal(isAncestor(repo, 'HEAD', bad), false);
  assert.equal(await isAncestorAsync(repo, bad, 'HEAD'), false);
  assert.equal(authorStamp(repo, bad), null);
  assert.throws(() => patchId(repo, bad));
  assert.throws(() => branchOfRef(repo, bad));
  assert.equal(await setUpstream(repo, bad), false);
  const remote = await remoteBranchSha(repo, bad);
  assert.equal(remote.ok, false);
  assert.equal(existsSync(file), false, 'git wrote the file the value named');
  // the options the callers pass on purpose still work, and so do plain values
  assert.deepEqual(commitLog(repo, ['HEAD', '--not', base]).length, 2);
  assert.equal(commitsInRange(repo, base, 'HEAD', { merges: false }).length, 2);
  assert.equal(isAncestor(repo, base, 'HEAD'), true);
  assert.equal(revParse(repo, 'HEAD').length, 40);
});

// every subcommand the adapters give --end-of-options takes it, on the git this machine has (rev-parse needs 2.30)
test('each subcommand given --end-of-options accepts it', () => {
  const { repo, base } = localRepo();
  const bare = tmp('bare');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '--bare', '-q', bare);
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'HEAD:refs/heads/trunk');
  git('fetch', '-q', 'origin');
  const calls: string[][] = [
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    ['rev-parse', '--end-of-options', 'HEAD'],
    ['merge-base', '--end-of-options', base, 'HEAD'],
    ['diff', '--end-of-options', base, 'HEAD'],
    ['log', '--end-of-options', 'HEAD'],
    ['rev-list', '--end-of-options', 'HEAD'],
    ['show', '--end-of-options', 'HEAD'],
    ['diff-tree', '--end-of-options', 'HEAD'],
    ['ls-remote', '--end-of-options', 'origin', 'refs/heads/trunk'],
    ['show-ref', '--end-of-options', 'refs/remotes/origin/trunk'],
    ['merge-base', '--is-ancestor', '--end-of-options', base, 'HEAD'],
  ];
  for (const args of calls) {
    assert.doesNotThrow(() => git(...args), args.join(' '));
  }
  git(
    'branch',
    '--set-upstream-to=origin/trunk',
    '--end-of-options',
    git('branch', '--show-current').trim(),
  );
});
