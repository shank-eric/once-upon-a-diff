import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTree } from '../src/records/worktrees/worktrees.ts';

const tree = (path: string, repo: string | null, branch: string | null) => ({ path, repo, branch });

test('findTree: the worktree on that repo and branch, the repo in any case', () => {
  const trees = [
    tree('/a', 'acme/widgets', 'main'),
    tree('/b', 'acme/gadgets', 'feature'),
    tree('/c', 'acme/widgets', 'feature'),
  ];
  assert.equal(findTree(trees, 'Acme/Widgets', 'feature')?.path, '/c');
  assert.equal(findTree(trees, 'acme/widgets', 'main')?.path, '/a');
});

test('findTree: nothing for another branch or repo, or for a worktree with no repo', () => {
  const trees = [tree('/a', 'acme/widgets', 'feature'), tree('/b', null, 'feature')];
  assert.equal(findTree(trees, 'acme/widgets', 'other'), undefined);
  assert.equal(findTree(trees, 'acme/gadgets', 'feature'), undefined);
  assert.equal(findTree([tree('/b', null, 'feature')], 'acme/widgets', 'feature'), undefined);
});
