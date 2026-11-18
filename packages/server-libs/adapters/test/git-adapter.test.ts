import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import {
  branchMovedPastAsync,
  branchNameAsync,
  commitLog,
  commitLogAsync,
  commitsBetween,
  isAncestor,
  isAncestorAsync,
  parseCommitLog,
  remoteBranchSha,
} from '../src/git.ts';

test('parseCommitLog reads sha, commit time and subject', () => {
  const text = [
    'a'.repeat(40) + '\t2026-11-04T10:00:00-05:00\tadd two',
    'b'.repeat(40) + '\t2026-11-03T09:30:00-05:00\tchange one',
    '',
  ].join('\n');
  assert.deepEqual(parseCommitLog(text), [
    { sha: 'a'.repeat(40), at: '2026-11-04T10:00:00-05:00', subject: 'add two' },
    { sha: 'b'.repeat(40), at: '2026-11-03T09:30:00-05:00', subject: 'change one' },
  ]);
  assert.deepEqual(parseCommitLog(''), []);
  assert.deepEqual(parseCommitLog('\n  \n'), []);
});

test('the log helpers agree on a real range, and the two failure shapes stay empty', async () => {
  const { repo, base } = localRepo();
  const viaBetween = commitsBetween(repo, base, 'HEAD');
  assert.deepEqual(
    viaBetween.map((commit) => commit.subject),
    ['add two', 'change one'],
  );
  assert.deepEqual(commitLog(repo, [`${base}..HEAD`]), viaBetween);
  assert.deepEqual(await commitLogAsync(repo, `${base}..HEAD`), viaBetween);
  assert.deepEqual(commitLog(repo, ['nope..HEAD']), []);
  assert.deepEqual(await commitLogAsync(repo, 'nope..HEAD'), []);
});

test('isAncestor and isAncestorAsync say false for a missing ref instead of throwing', async () => {
  const { repo, base } = localRepo();
  assert.equal(isAncestor(repo, base, 'HEAD'), true);
  assert.equal(isAncestor(repo, 'HEAD', base), false);
  assert.equal(isAncestor(repo, 'nope', 'HEAD'), false);
  assert.equal(await isAncestorAsync(repo, base, 'HEAD'), true);
  assert.equal(await isAncestorAsync(repo, 'HEAD', base, 5000), false);
  assert.equal(await isAncestorAsync(repo, 'nope', 'HEAD'), false);
});

test('branchNameAsync names the branch, and remoteBranchSha reports a repo with no origin as an error', async () => {
  const { repo } = localRepo();
  assert.equal(await branchNameAsync(repo, 3000), 'feature');
  const remote = await remoteBranchSha(repo, 'feature');
  assert.equal(remote.ok, false);
});

test('branchMovedPastAsync: a commit on top and an amend moved; the same tip, a rebase onto a moved main and a missing commit did not', async () => {
  const { repo } = localRepo();
  const bases = ['main', 'origin/main'];
  // main is the base; feat has its own commit X
  const base = git(repo, 'rev-parse', 'HEAD~2');
  git(repo, 'branch', '-f', 'main', base);
  git(repo, 'checkout', '-q', '-B', 'feat', 'main');
  const commit = (file: string, text: string, ...flags: string[]) => {
    writeFileSync(path.join(repo, file), `${text}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', ...flags, '-m', text);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const told = commit('feat.txt', 'the change');
  assert.equal(await branchMovedPastAsync(repo, told, told, bases), false, 'the same tip');
  // a new commit on top
  const onTop = commit('more.txt', 'one more');
  assert.equal(await branchMovedPastAsync(repo, told, onTop, bases), true);
  // an amend of X (not a descendant of it): a different patch
  git(repo, 'reset', '-q', '--hard', told);
  writeFileSync(path.join(repo, 'extra.txt'), 'extra\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--amend', '-m', 'the change, amended');
  const amended = git(repo, 'rev-parse', 'HEAD');
  assert.equal(await branchMovedPastAsync(repo, told, amended, bases), true);
  // a message-only amend is the same patch: not moved
  git(repo, 'reset', '-q', '--hard', told);
  git(repo, 'commit', '-q', '--amend', '-m', 'reworded');
  const reworded = git(repo, 'rev-parse', 'HEAD');
  assert.equal(await branchMovedPastAsync(repo, told, reworded, bases), false);
  // main moves on and feat is rebased onto it: every sha changes, no patch does
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'main.txt'), 'main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves');
  git(repo, 'checkout', '-q', 'feat');
  git(repo, 'reset', '-q', '--hard', told);
  git(repo, 'rebase', '-q', 'main');
  const rebased = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(rebased, told);
  assert.equal(await branchMovedPastAsync(repo, told, rebased, bases), false);
  // origin/main lags local main (never pushed): a pure rebase onto local main still has not moved
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'main2.txt'), 'main again\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves again');
  git(repo, 'checkout', '-q', 'feat');
  git(repo, 'rebase', '-q', 'main');
  const rebasedAgain = git(repo, 'rev-parse', 'HEAD');
  assert.equal(await branchMovedPastAsync(repo, rebased, rebasedAgain, bases), false);
  // git cannot say: a commit that is not there, or no base to compare with
  assert.equal(await branchMovedPastAsync(repo, '0'.repeat(40), rebased, bases), null);
  assert.equal(await branchMovedPastAsync(repo, told, rebased, []), null);
});
