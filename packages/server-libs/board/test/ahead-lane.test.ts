import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import { columnOf, onLocalSide, type ColumnInput } from '../src/columns.ts';

const mine = { state: 'open', mine: true } as PrInfo;
const theirs = { state: 'open', mine: false } as PrInfo;
const local = (over: Partial<NonNullable<ColumnInput['story']>> = {}): ColumnInput['story'] => ({
  reviewed: false,
  manualReviewedAt: null,
  unread: false,
  local: true,
  ...over,
});
const input = (over: Partial<ColumnInput> = {}): ColumnInput => ({
  sessions: [],
  agents: [],
  pr: mine,
  story: local(),
  ahead: true,
  ...over,
});

test('onLocalSide: no PR, or a PR whose branch is ahead', () => {
  assert.equal(onLocalSide({ pr: null, ahead: false }), true);
  assert.equal(onLocalSide({ pr: mine, ahead: true }), true);
  assert.equal(onLocalSide({ pr: mine, ahead: false }), false);
  assert.equal(onLocalSide({ pr: mine }), false);
});

test('an ahead PR with an unreviewed local story is Ready, a reviewed one stays Ready until approved', () => {
  assert.equal(columnOf(input()), 'ready');
  assert.equal(columnOf(input({ story: local({ reviewed: true }) })), 'ready');
});

test('an ahead PR with an approved local story is Ready to ship', () => {
  assert.equal(columnOf(input({ story: local({ reviewed: true, approved: true }) })), 'ship');
});

test('an unread answer or unread local story on an ahead PR is Ready, not Back to you', () => {
  assert.equal(columnOf(input({ story: local({ reviewed: true, answered: 1 }) })), 'ready');
  assert.equal(columnOf(input({ story: local({ reviewed: true, unread: true }) })), 'ready');
});

test('working, waiting and failed agents still win over an ahead card', () => {
  const approved = local({ reviewed: true, approved: true });
  const agent = (state: 'running' | 'failed') => [{ status: 'x', state }] as never;
  assert.equal(columnOf(input({ story: approved, agents: agent('running') })), 'working');
  assert.equal(columnOf(input({ story: approved, agents: agent('failed') })), 'error');
  assert.equal(columnOf(input({ sessions: [{ status: 'waiting' }] as never })), 'waiting');
});

test("not ahead, a PR story, someone else's PR: the PR side as before", () => {
  assert.equal(columnOf(input({ ahead: false })), 'pr_open');
  assert.equal(
    columnOf(input({ ahead: false, story: local({ reviewed: true, approved: true }) })),
    'pr_open',
  );
  assert.equal(
    columnOf(input({ ahead: false, story: local({ local: false, reviewed: true }) })),
    'pr_open',
  );
  assert.equal(columnOf(input({ story: local({ local: false, unread: true }) })), 'back');
  assert.equal(
    columnOf(input({ ahead: false, story: local({ reviewed: true, answered: 1 }) })),
    'back',
  );
});

test('the caller sets ahead only for your own open PR: columnOf takes it as given', () => {
  assert.equal(columnOf(input({ pr: theirs, ahead: false })), 'pr_open');
});

test('a merged PR is Done whatever ahead says', () => {
  assert.equal(columnOf(input({ pr: { state: 'merged', mine: true } as PrInfo })), 'done');
});

test('an ahead PR with no story at all (an author committed after the push) is Ready', () => {
  assert.equal(columnOf(input({ story: null })), 'ready');
  assert.equal(columnOf(input({ story: null, ahead: false })), 'pr_open');
});

test('an ahead PR with a PR story: read, Ready; unread or answered, still Back to you', () => {
  assert.equal(columnOf(input({ story: local({ local: false, reviewed: true }) })), 'ready');
  assert.equal(columnOf(input({ story: local({ local: false }) })), 'ready');
  assert.equal(columnOf(input({ story: local({ local: false, unread: true }) })), 'back');
  assert.equal(columnOf(input({ story: local({ local: false, answered: 1 }) })), 'back');
});

test('an ahead PR is never Ready to ship without an approved local story', () => {
  assert.equal(columnOf(input({ story: null })), 'ready');
  assert.equal(
    columnOf(input({ story: local({ local: false, reviewed: true, approved: true }) })),
    'ready',
  );
});

test('an ahead PR whose branch moved past what was told is Working', () => {
  assert.equal(columnOf(input({ story: null, moved: true })), 'working');
  assert.equal(columnOf(input({ moved: true })), 'working');
});
