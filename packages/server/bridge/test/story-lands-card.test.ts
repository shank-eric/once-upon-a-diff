/** A merged story lands its stored (non-listed) card at the PR's merged_at; a listed card is MergeLander's, a closed PR lands nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmp } from './helpers.ts';
import { ensureCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { InboxStory, PrInfo } from '@once-upon-a-diff/contracts/types';
import type { PrFacts } from '@once-upon-a-diff/state/records/github/github-checks';

const REPO = 'acme/widgets';
const MERGED_AT = new Date(Date.now() - 40 * 60000).toISOString();

const story: InboxStory = {
  id: 'pr-7',
  repo: REPO,
  number: 7,
  title: 'PR 7',
  branch: 'feat-a',
  url: `https://github.com/${REPO}/pull/7`,
  built_at: new Date(0).toISOString(),
  seen_at: null,
  reviewed_at: null,
  reviewed_by: null,
};

const info = { number: 7, state: 'merged', merged_at: MERGED_AT } as PrInfo;

async function kickWith(facts: PrFacts, setup: (store: BacklogStore) => string) {
  const home = tmp('story-lands-home');
  const store = new BacklogStore(home);
  const id = setup(store);
  const review = new AutoReview(
    new StoryStore({ home }),
    async () => facts,
    1000,
    undefined,
    undefined,
    home,
  );
  review.kick([story], 1000);
  await review.idle();
  review.kick([story], 5000);
  await review.idle();
  return { store, card: store.items().find((one) => one.id === id)! };
}

const storedCard = (store: BacklogStore) =>
  ensureCard(store, { source: 'pr', title: 'PR 7', repo: REPO, pr: 7, story: 'pr-7' }).item.id;

test('a merged story lands its stored card at the PR merged_at, and a second kick writes nothing', async () => {
  const { store, card } = await kickWith({ merged: true, why: null, info }, storedCard);
  assert.equal(card.landed_at, MERGED_AT);
  const dones = readFileSync(store.file, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"op":"done"'));
  assert.equal(dones.length, 1);
});

test('a listed card on the PR is left to MergeLander', async () => {
  const { card } = await kickWith({ merged: true, why: null, info }, (store) => {
    const listed = store.add({ title: 'listed', repo: REPO, branch: 'feat-a' });
    return store.link(listed.id, { pr: 7 }).id;
  });
  assert.equal(card.landed_at, null);
});

test('a PR closed with its branch deleted lands nothing', async () => {
  const { card } = await kickWith({ merged: false, abandoned: true, why: null, info }, storedCard);
  assert.equal(card.landed_at, null);
});
