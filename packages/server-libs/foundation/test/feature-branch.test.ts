import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BRANCHES, isFeatureBranch } from '../src/settings.ts';

test('isFeatureBranch: a named branch that is not a default branch', () => {
  assert.equal(isFeatureBranch('readability-branch-predicate'), true);
  assert.equal(isFeatureBranch('main-menu'), true);
});

test('isFeatureBranch: every default branch is refused', () => {
  for (const name of DEFAULT_BRANCHES) {
    assert.equal(isFeatureBranch(name), false, name);
  }
});

test('isFeatureBranch: no branch (detached HEAD, unknown) is refused', () => {
  assert.equal(isFeatureBranch(null), false);
  assert.equal(isFeatureBranch(undefined), false);
  assert.equal(isFeatureBranch(''), false);
});
