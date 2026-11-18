import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyFactsFor } from '../src/stages/ready-facts.ts';
import type { PrWatcher } from '../src/stages/pr-watcher.ts';
import type { WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';

const tree = { repo: 'acme/widgets', branch: 'feat/x', unpushed: 0 } as WorktreeFacts;
const watcher = (answer: unknown, info: unknown = null) => {
  const asked: string[] = [];
  const review = {
    branchPr: () => answer,
    kickBranch: () => asked.push('branch'),
    kickInfo: (_repo: string, number: number) => asked.push(`info ${number}`),
    info: () => info,
  } as unknown as PrWatcher;
  return { review, asked };
};
const branch = { repo: 'acme/widgets', branch: 'feat/x' };

test('readyFactsFor reads the watcher and the scanner, and asks only for a typed PR number', () => {
  const none = watcher(null);
  assert.deepEqual(readyFactsFor(none.review, branch, [tree], 0), { pr: 'none', pushed: true });
  assert.deepEqual(none.asked, [], 'a branch is the Worktrees lane’s and the Backlog links’ ask');
  assert.deepEqual(readyFactsFor(none.review, branch, [], 0), { pr: 'none', pushed: null });
  assert.deepEqual(readyFactsFor(watcher(undefined).review, branch, [tree], 0), {
    pr: 'unknown',
    pushed: true,
  });
  const typed = watcher(null, { state: 'open' });
  assert.deepEqual(readyFactsFor(typed.review, { ...branch, typedPr: 5 }, [tree], 0), {
    pr: 'open',
    pushed: true,
  });
  assert.deepEqual(typed.asked, ['info 5']);
  const closed = watcher(null, { state: 'closed' });
  assert.equal(readyFactsFor(closed.review, { ...branch, typedPr: 5 }, [tree], 0).pr, 'none');
  // no repo or branch: nothing known, nothing asked
  const bare = watcher(null);
  assert.deepEqual(readyFactsFor(bare.review, { repo: null, branch: 'x', typedPr: 5 }, [tree], 0), {
    pr: 'unknown',
    pushed: null,
  });
  assert.deepEqual(bare.asked, []);
});
