import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftView, shownIn } from '../src/drafts/drafts.ts';
import type { DraftFix } from '@once-upon-a-diff/contracts/types';

test('a draft in fix before push shows as such, and a dismissed one stays dismissed', () => {
  assert.equal(
    draftView({ status: 'draft', dismissed: false, fix: { id: 'n1', done: false } as DraftFix })
      .show,
    'fix',
  );
  assert.equal(
    draftView({ status: 'draft', dismissed: true, fix: { id: 'n1', done: false } as DraftFix })
      .show,
    'dismissed',
  );
});

test('the panel shows an added draft until gh matches it on a page loaded after the add, or it turns up on the page', () => {
  const addedAt = '2026-10-21T15:00:00.000Z';
  const addedMillis = Date.parse(addedAt);
  const added = { at: addedAt, url: 'u', started: false };
  const before = { pageAt: addedMillis - 60000 };
  const after = { pageAt: addedMillis + 60000 };
  assert.deepEqual(draftView({ status: 'draft', dismissed: false, added }, before), {
    show: 'added',
    settle: false,
  });
  // gh already sees it, but this page was loaded before the add, so GitHub isn't showing it here
  assert.deepEqual(
    draftView({ status: 'pending', source: 'github', dismissed: false, added }, before),
    { show: 'added', settle: false },
  );
  assert.deepEqual(
    draftView({ status: 'pending', source: 'github', dismissed: false, added }, after),
    { show: 'pending', settle: true },
  );
  assert.deepEqual(
    draftView({ status: 'draft', dismissed: false, added }, after),
    { show: 'added', settle: false },
    "reloaded, but gh hasn't caught up yet",
  );
  assert.deepEqual(
    draftView({ status: 'draft', dismissed: false, added }, { ...before, onPage: true }),
    { show: 'pending', settle: false },
  );
  assert.deepEqual(
    draftView({ status: 'posted', source: 'github', dismissed: false, added }, before),
    { show: 'posted', settle: true },
    'submitted since',
  );
  // without an add, the states are what they were
  assert.equal(
    draftView({ status: 'pending', source: 'github', dismissed: false, added: null }, before).show,
    'pending',
  );
  assert.equal(draftView({ status: 'draft', dismissed: true, added: null }).show, 'dismissed');
  assert.equal(draftView(undefined).show, 'draft');
});

test("finding the added comment in the page's rendered comments", () => {
  const body =
    'Could you confirm what happens with an `empty` list here? See [the docs](https://example.com/x).';
  assert.ok(
    shownIn(
      ['Octocat Pending', 'Could you confirm what happens with an empty list here? See the docs.'],
      body,
    ),
  );
  assert.ok(!shownIn(['Nice tidy-up of the old code.'], body));
  assert.ok(!shownIn(['ok'], 'ok'), 'too short to tell');
});
