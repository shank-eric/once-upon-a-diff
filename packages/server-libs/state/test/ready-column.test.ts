import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyColumn, readyFactsOf, UNKNOWN_READY } from '../src/queues/backlog/ready.ts';
import { cardPhase } from '../src/queues/backlog/phase.ts';
import type { LedgerAgent } from '../src/records/agents/ledger.ts';

const open = { number: 9, state: 'open' as const, merged_at: null };
const merged = { number: 9, state: 'merged' as const, merged_at: '2026-11-17T00:00:00Z' };

test('readyFactsOf: GitHub’s answer for the branch and for a typed number, and the push state', () => {
  assert.deepEqual(readyFactsOf({ branchPr: open, unpushed: 3 }), { pr: 'open', pushed: false });
  assert.deepEqual(readyFactsOf({ branchPr: null, unpushed: 0 }), { pr: 'none', pushed: true });
  assert.deepEqual(readyFactsOf({ branchPr: undefined, unpushed: 0 }), {
    pr: 'unknown',
    pushed: true,
  });
  assert.deepEqual(readyFactsOf({ branchPr: null, unpushed: undefined }), {
    pr: 'none',
    pushed: null,
  });
  assert.deepEqual(readyFactsOf({ branchPr: null, unpushed: null }), { pr: 'none', pushed: null });
  // a typed PR counts only once GitHub answered for it
  assert.equal(readyFactsOf({ branchPr: null, typedPr: null, unpushed: 0 }).pr, 'none');
  assert.equal(
    readyFactsOf({ branchPr: null, typedPr: { state: 'open' }, unpushed: 0 }).pr,
    'open',
  );
  assert.equal(
    readyFactsOf({ branchPr: undefined, typedPr: { state: 'open' }, unpushed: 0 }).pr,
    'open',
  );
  // closed is no open PR, whichever way it is found
  assert.equal(
    readyFactsOf({ branchPr: null, typedPr: { state: 'closed' }, unpushed: 0 }).pr,
    'none',
  );
  assert.equal(
    readyFactsOf({ branchPr: undefined, typedPr: { state: 'closed' }, unpushed: 0 }).pr,
    'unknown',
  );
  // merged is the merge paths’: unknown here, so each door keeps its column from before
  assert.equal(readyFactsOf({ branchPr: merged, unpushed: 0 }).pr, 'unknown');
  assert.equal(
    readyFactsOf({ branchPr: null, typedPr: { state: 'merged' }, unpushed: 0 }).pr,
    'unknown',
  );
});

test('readyColumn: an open PR is PR open, pushed with no PR is Ready to ship, anything else is Ready for your review', () => {
  assert.equal(readyColumn({ pr: 'open', pushed: false }), 'pr_open');
  assert.equal(readyColumn({ pr: 'open', pushed: true }), 'pr_open');
  assert.equal(readyColumn({ pr: 'none', pushed: true }), 'ship');
  assert.equal(readyColumn({ pr: 'none', pushed: false }), 'ready');
  assert.equal(readyColumn({ pr: 'none', pushed: null }), 'ready');
  assert.equal(readyColumn({ pr: 'unknown', pushed: true }), 'ready');
  assert.equal(readyColumn(UNKNOWN_READY), 'ready');
  // a repo that skips review is Ready to ship, but an open PR still wins
  assert.equal(readyColumn(UNKNOWN_READY, true), 'ship');
  assert.equal(readyColumn({ pr: 'none', pushed: false }, true), 'ship');
  assert.equal(readyColumn({ pr: 'open', pushed: true }, true), 'pr_open');
});

test('readyColumn: a branch that moved past what was reviewed is Working, only where it would be Ready', () => {
  assert.equal(readyColumn({ pr: 'none', pushed: false, working: true }), 'working');
  assert.equal(readyColumn({ pr: 'unknown', pushed: null, working: true }), 'working');
  assert.equal(readyColumn({ pr: 'none', pushed: false, working: false }), 'ready');
  assert.equal(readyColumn({ pr: 'none', pushed: true, working: true }), 'ship');
  assert.equal(readyColumn({ pr: 'none', pushed: false, working: true }, true), 'ship');
  assert.equal(readyColumn({ pr: 'open', pushed: false, working: true }), 'pr_open');
});

const NOW = Date.parse('2026-11-18T15:00:00Z');
const finished: LedgerAgent = {
  sid: 'aaaaaaaa',
  name: 'ou-x',
  kind: 'author',
  state: 'done',
  model: null,
  modelName: null,
  task: null,
  started: new Date(NOW - 3600000),
  ended: new Date(NOW - 1800000),
  outcome: null,
  card: 'bl_aaaaaa111111',
};

// Larmor holds a card for its critic, so a passing one is on every card here
const critic: LedgerAgent = {
  ...finished,
  kind: 'critic',
  name: 'review-x',
  findings: 0,
  ended: new Date(NOW - 600000),
};

test('cardPhase row 6 takes the facts: unknown is today’s column', () => {
  const item = { state: 'started' as const, repo: 'acme/widgets', branch: 'feat/x' };
  const column = (facts?: Parameters<typeof cardPhase>[3], skipsReview = false) =>
    cardPhase(item, [finished, critic], NOW, facts, skipsReview);
  assert.equal(column()?.column, 'ready');
  assert.equal(column(UNKNOWN_READY)?.column, 'ready');
  assert.equal(column({ pr: 'none', pushed: false })?.column, 'ready');
  assert.equal(column({ pr: 'none', pushed: true })?.column, 'ship');
  assert.equal(column({ pr: 'open', pushed: false })?.column, 'pr_open');
  assert.equal(column({ pr: 'open', pushed: false })?.row, '6');
  assert.equal(column({ pr: 'none', pushed: false, working: true })?.column, 'working');
  assert.equal(column({ pr: 'none', pushed: false, working: true })?.row, '6');
  assert.equal(column(undefined, true)?.column, 'ship', 'a skip-review repo');
  assert.equal(
    column({ pr: 'open', pushed: true }, true)?.column,
    'pr_open',
    'an open PR wins over skip-review',
  );
});
