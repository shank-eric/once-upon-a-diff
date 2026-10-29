import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupConfirm, sizeText, worktreeChips } from '../src/util/worktree-text.ts';
import type { BoardWorktree } from '../src/types.ts';

const tree = (over: Partial<BoardWorktree> = {}): BoardWorktree => ({
  path: '/d/widgets-worktrees/x',
  name: 'x',
  repo: 'acme/widgets',
  lane: 'widgets',
  main: '/d/widgets',
  branch: 'x',
  last_commit_at: null,
  state: 'clean',
  modified: 0,
  untracked: 0,
  unpushed: 0,
  size_kb: 2097152,
  pr: { number: null, state: 'none' },
  verdict: 'merged',
  in_use: [],
  locked: false,
  ignored: [],
  attention: null,
  stale: false,
  removable: true,
  keep: [],
  deletes_branch: true,
  ...over,
});

test('sizes read in K, M and G', () => {
  assert.deepEqual([sizeText(12), sizeText(2048), sizeText(1572864)], ['12K', '2M', '1.5G']);
});

test('chips: age, clean or dirty, merged state, unpushed, PR, size', () => {
  assert.deepEqual(worktreeChips(tree(), '3d ago'), [
    'last commit 3d ago',
    'clean',
    'merged',
    '2.0G',
  ]);
  assert.deepEqual(
    worktreeChips(
      tree({
        state: 'dirty',
        modified: 2,
        untracked: 1,
        verdict: 'unmerged',
        unpushed: 3,
        pr: { number: 9, state: 'open' },
        size_kb: null,
        in_use: ['the builder'],
        locked: true,
      }),
      '',
    ),
    ['dirty (2M 1?)', 'not merged', '3 unpushed', 'PR #9 open', 'locked', 'in use by the builder'],
  );
});

test('the confirm says what goes and what stays, and that a superseded one is only superseded', () => {
  const merged = cleanupConfirm(tree());
  assert.match(merged, /Remove the folder \/d\/widgets-worktrees\/x/);
  assert.match(merged, /branch x is merged, so it is deleted too/);
  assert.doesNotMatch(merged, /SUPERSEDED/);
  const superseded = cleanupConfirm(tree({ verdict: 'superseded', deletes_branch: false }));
  assert.match(superseded, /SUPERSEDED, not merged/);
  assert.match(superseded, /branch x is kept/);
  assert.match(cleanupConfirm(tree({ branch: null, deletes_branch: false })), /detached HEAD/);
  const ignored = cleanupConfirm(tree({ ignored: ['.env', 'x.local.json'] }));
  assert.match(ignored, /IGNORED FILES.*deleted with the folder/);
  assert.ok(ignored.includes('\n  .env\n  x.local.json\n'));
  assert.deepEqual(worktreeChips(tree({ ignored: ['.env'], attention: 'x' }), '').slice(-2), [
    '1 ignored file to lose',
    'needs attention',
  ]);
});
