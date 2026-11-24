import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { cardRiddenOn, ridesOnWork } from '../src/queues/backlog/backlog.ts';

type Item = Parameters<typeof cardRiddenOn>[0] & Parameters<typeof ridesOnWork>[0];
const open = (over: Partial<Item> = {}): Item => ({
  state: 'open',
  branch: 'feat/x',
  repo: 'acme/widgets',
  landed_at: null,
  pr: 7,
  someday: false,
  ...over,
});
const card = (over: object) =>
  ({
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'feat/x',
    agents: [],
    ...over,
  }) as never as Parameters<typeof cardRiddenOn>[1][0];

test('an open card with a PR rides on work, unless it was set aside for someday or has no branch', () => {
  assert.equal(ridesOnWork(open()), true);
  assert.equal(ridesOnWork(open({ someday: true })), false);
  assert.equal(ridesOnWork(open({ branch: null })), false);
  assert.equal(ridesOnWork(open({ pr: null })), false);
});

test('an open card rides on its PR’s own card, not on another PR’s or a session on the reused branch', () => {
  const own = card({ pr: { number: 7 } });
  const another = card({ pr: { number: 9 } });
  const session = card({ kind: 'session' });
  assert.equal(cardRiddenOn(open(), [another, session, own]), own);
  // its PR closed: no card for it is shown, and what is on its branch now is not its work
  assert.equal(cardRiddenOn(open(), [another, session]), undefined);
});

test('a started or landed card still finds the card on its branch', () => {
  const another = card({ pr: { number: 9 } });
  assert.equal(cardRiddenOn(open({ state: 'started' }), [another]), another);
  assert.equal(cardRiddenOn(open({ landed_at: '2026-10-26T14:00:00Z' }), [another]), another);
});
