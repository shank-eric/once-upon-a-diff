import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from '@once-upon-a-diff/test-kit/git';
import {
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
