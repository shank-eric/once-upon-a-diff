import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardCard, InboxLocalStory, PrInfo } from '@once-upon-a-diff/contracts/types';
import {
  couldBeReady,
  isApprovedLocal,
  isLandedLocal,
  isLocalStoryCard,
  type ColumnInput,
} from '../src/columns.ts';
import { isStorylessReview } from '../src/stages/cards.ts';
import { isBranchWithLocalStory, isResolved } from '../src/stages/works.ts';
import type { Work } from '../src/stages/types.ts';

const story = (over: Partial<NonNullable<BoardCard['story']>> = {}): BoardCard['story'] => ({
  id: 's1',
  kind: 'local',
  url: null,
  reviewed: false,
  unread: false,
  unread_answers: 0,
  approved_at: null,
  ...over,
});
const card = (over: Partial<BoardCard> = {}): BoardCard =>
  ({
    id: 'c1',
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'feat/x',
    story: story(),
    pr: null,
    ...over,
  }) as BoardCard;
const pr = { state: 'open' } as PrInfo;

test('isLocalStoryCard: a local story and no PR', () => {
  assert.equal(isLocalStoryCard(card()), true);
  assert.equal(isLocalStoryCard(card({ story: story({ kind: 'pr' }) })), false);
  assert.equal(isLocalStoryCard(card({ story: null })), false);
  assert.equal(isLocalStoryCard(card({ pr })), false);
});

test('couldBeReady: local story, no PR, not landed, not approved, not reviewed, with a repo and branch', () => {
  assert.equal(couldBeReady(card()), true);
  assert.equal(couldBeReady(card({ kind: 'session' })), true);
  assert.equal(couldBeReady(card({ kind: 'agent' })), false);
  assert.equal(couldBeReady(card({ story: story({ kind: 'pr' }) })), false);
  assert.equal(couldBeReady(card({ story: null })), false);
  assert.equal(couldBeReady(card({ pr })), false);
  assert.equal(couldBeReady(card({ landed: { card: 'bl_1', at: '2026-01-01T00:00:00Z' } })), false);
  assert.equal(
    couldBeReady(card({ story: story({ approved_at: '2026-01-01T00:00:00Z' }) })),
    false,
  );
  assert.equal(couldBeReady(card({ repo: null })), false);
  assert.equal(couldBeReady(card({ branch: null })), false);
});

test('couldBeReady: a reviewed story counts only while an answer is unread', () => {
  assert.equal(couldBeReady(card({ story: story({ reviewed: true }) })), false);
  assert.equal(couldBeReady(card({ story: story({ reviewed: true, unread_answers: 2 }) })), true);
  // unread alone does not bring a reviewed story back: that is columnOf's Ready, not a moving branch's
  assert.equal(couldBeReady(card({ story: story({ reviewed: true, unread: true }) })), false);
});

const column = (over: Partial<ColumnInput> = {}): Pick<ColumnInput, 'story' | 'pr'> => ({
  pr: null,
  story: { reviewed: false, manualReviewedAt: null, unread: false, local: true },
  ...over,
});
const withStory = (extra: Record<string, boolean>) =>
  column({ story: { ...column().story!, ...extra } });

test('isLandedLocal: a landed local story with no PR', () => {
  assert.equal(isLandedLocal(withStory({ landed: true })), true);
  assert.equal(isLandedLocal(withStory({ landed: false })), false);
  assert.equal(isLandedLocal(withStory({ landed: true, local: false })), false);
  assert.equal(isLandedLocal({ ...withStory({ landed: true }), pr }), false);
  assert.equal(isLandedLocal({ story: null, pr: null }), false);
});

test('isApprovedLocal: an approved local story with no PR', () => {
  assert.equal(isApprovedLocal(withStory({ approved: true })), true);
  assert.equal(isApprovedLocal(withStory({ approved: false })), false);
  assert.equal(isApprovedLocal(withStory({ approved: true, local: false })), false);
  assert.equal(isApprovedLocal({ ...withStory({ approved: true }), pr }), false);
  assert.equal(isApprovedLocal({ story: null, pr: null }), false);
});

const local = (over: Partial<InboxLocalStory> = {}) =>
  ({ id: 'l1', approved_at: null, reviewed_at: null, ...over }) as InboxLocalStory;

test('isStorylessReview: a local story marked storyless', () => {
  assert.equal(isStorylessReview(local({ storyless: true })), true);
  assert.equal(isStorylessReview(local()), false);
  assert.equal(isStorylessReview({ id: 'p1', number: 7, storyless: true } as never), false);
  assert.equal(isStorylessReview(null), false);
});

const work = (over: Partial<Work> = {}): Work => ({
  key: 'k',
  repo: 'acme/widgets',
  number: null,
  branch: 'feat/x',
  story: null,
  local: local(),
  mergedAt: null,
  title: null,
  built: false,
  sessions: [],
  ...over,
});

test('isBranchWithLocalStory: a local story on a repo and branch, with no PR, PR story or merge', () => {
  assert.equal(isBranchWithLocalStory(work()), true);
  assert.equal(isBranchWithLocalStory(work({ local: null })), false);
  assert.equal(isBranchWithLocalStory(work({ number: 5 })), false);
  assert.equal(isBranchWithLocalStory(work({ story: { id: 'p' } as Work['story'] })), false);
  assert.equal(isBranchWithLocalStory(work({ mergedAt: '2026-01-01T00:00:00Z' })), false);
  assert.equal(isBranchWithLocalStory(work({ repo: null })), false);
  assert.equal(isBranchWithLocalStory(work({ branch: null })), false);
});

test('isResolved: reviewed and not approved', () => {
  assert.equal(isResolved(local({ reviewed_at: '2026-01-01T00:00:00Z' })), true);
  assert.equal(isResolved(local()), false);
  assert.equal(
    isResolved(local({ reviewed_at: '2026-01-01T00:00:00Z', approved_at: '2026-01-02T00:00:00Z' })),
    false,
  );
  assert.equal(isResolved(local({ approved_at: '2026-01-02T00:00:00Z' })), false);
});
