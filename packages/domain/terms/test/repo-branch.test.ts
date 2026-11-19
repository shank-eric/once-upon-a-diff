import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRepoAndBranch } from '../src/repo-branch.ts';

test('hasRepoAndBranch is true only when both a repo and a branch are named', () => {
  assert.equal(hasRepoAndBranch({ repo: 'o/r', branch: 'feature' }), true);
  assert.equal(hasRepoAndBranch({ repo: null, branch: 'feature' }), false);
  assert.equal(hasRepoAndBranch({ repo: 'o/r', branch: null }), false);
  assert.equal(hasRepoAndBranch({ repo: null, branch: null }), false);
  assert.equal(hasRepoAndBranch({ repo: '', branch: 'feature' }), false);
  assert.equal(hasRepoAndBranch({ repo: 'o/r', branch: '' }), false);
});
