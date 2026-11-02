import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  tmp,
  git,
  githubStory,
  startBridge,
  runCli,
  localRepo,
  writeJson,
  TOKEN,
} from './helpers.ts';
import { createLocalStory } from '../src/services/stories/local-story.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Inbox } from '../src/services/inbox/inbox.ts';
import { AutoReview, type BranchCheck } from '../src/services/review/auto-review.ts';
import { APPROVED_DAYS, approvalOf } from '../src/services/review/approve.ts';
import { localEntries, localStories } from '../src/services/review/story-lists.ts';
import { columnOf } from '../src/services/board/columns.ts';
import { boardKey, pageKey, viewKey } from '../src/services/pages/page-key.ts';
import type { Printable } from '../src/cli/output.ts';
import type { BoardData, StoryData } from '@once-upon-a-diff/shared/types';

/** A local story on a real checkout, and a bridge serving it. */
async function setup(options: { checkBranch?: BranchCheck } = {}) {
  const home = tmp('home');
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [{ title: 'Chapter 1', files: ['one.txt'] }],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const bridge = await startBridge({ home, checkBranch: options.checkBranch });
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const post = (key: string, url: string, body: unknown) =>
    bridge.call<{ error?: string; approved?: { at: string; head_oid: string } | null }>(
      'POST',
      url,
      body,
      { Authorization: `Bearer ${key}` },
    );
  const events = () =>
    new Inbox(home)
      .all()
      .filter((entry) => (entry as { type: string }).type === 'approved') as unknown as {
      story: string;
      head_sha: string;
      branch: string;
    }[];
  return { home, repo, id, bridge, head, post, events, store: new StoryStore({ home }) };
}

const commit = (repo: string, name: string) => {
  writeFileSync(path.join(repo, name), `${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', name);
};

test('Approve records the head, marks the story reviewed, tells a listener once, and refuses a stale head', async () => {
  const { id, bridge, head, post, events, store, repo } = await setup();
  try {
    const url = `/api/stories/${id}/approve`;
    const stale = await post(pageKey(TOKEN, id), url, { head_sha: 'a'.repeat(40) });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(events().length, 0);

    const first = await post(pageKey(TOKEN, id), url, { head_sha: head() });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.approved?.head_oid, head());
    const state = store.readState<{ by: string; at: string } | null>(id, 'reviewed.json', null);
    assert.equal(state?.by, 'approved');
    assert.equal(events().length, 1);
    assert.equal(events()[0].head_sha, head());
    assert.equal(events()[0].branch, 'feature');

    await post(pageKey(TOKEN, id), url, { head_sha: head() });
    assert.equal(events().length, 1, 'a second click at the same head is not another event');

    const data = (
      await bridge.call<StoryData>('GET', `/api/stories/${id}`, undefined, {
        Authorization: `Bearer ${pageKey(TOKEN, id)}`,
      })
    ).body;
    assert.equal(data.local?.approved?.head_oid, head());

    // a new commit: the page's head moves, so the approval no longer counts
    commit(repo, 'three.txt');
    const moved = await post(pageKey(TOKEN, id), url, { head_sha: head() });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(events().length, 2, 'approving the new head is a new event');
  } finally {
    await bridge.close();
  }
});

test('Unapprove takes back the mark approving wrote, but not one made by hand', async () => {
  const { id, bridge, head, post, store } = await setup();
  try {
    const url = `/api/stories/${id}/approve`;
    await post(pageKey(TOKEN, id), url, { head_sha: head() });
    const off = await post(pageKey(TOKEN, id), url, { approved: false });
    assert.equal(off.body.approved, null);
    assert.equal(
      store.readState(id, 'reviewed.json', null),
      null,
      'no mark left, so the background checks can still call it done',
    );
    assert.equal(localStories(store)[0].reviewed_at, null, 'back in Ready');
    assert.equal(approvalOf(store, id, head()), null);

    // marked reviewed by hand first: approving keeps that mark, and so does unapproving
    store.writeState(id, 'reviewed.json', { at: '2026-10-28T12:00:00.000Z', by: 'manual' });
    await post(pageKey(TOKEN, id), url, { head_sha: head() });
    assert.equal(store.readState<{ by: string } | null>(id, 'reviewed.json', null)?.by, 'manual');
    await post(pageKey(TOKEN, id), url, { approved: false });
    assert.equal(
      store.readState<{ at: string } | null>(id, 'reviewed.json', null)?.at,
      '2026-10-28T12:00:00.000Z',
    );
  } finally {
    await bridge.close();
  }
});

test('only the full page key approves: not the read-only key, the board key, another story, or a PR story', async () => {
  const { home, id, bridge, head, post, events } = await setup();
  try {
    const url = `/api/stories/${id}/approve`;
    for (const key of [viewKey(TOKEN, id), boardKey(TOKEN), pageKey(TOKEN, 'other')]) {
      const refused = await post(key, url, { head_sha: head() });
      assert.equal(refused.status, 403, refused.text);
    }
    assert.equal(events().length, 0);
    const missing = await post(pageKey(TOKEN, 'nope'), '/api/stories/nope/approve', {
      head_sha: head(),
    });
    assert.equal(missing.status, 404);
    githubStory(path.join(home, 'acme-widgets-7'));
    const pr = await bridge.call('POST', '/api/stories/acme-widgets-7/approve', { head_sha: 'x' });
    assert.equal(pr.status, 400, 'a PR story is approved on GitHub');
  } finally {
    await bridge.close();
  }
});

test('an approval counts only for its head and for APPROVED_DAYS, and the background check clears it when the branch moves', async () => {
  const { home, id, bridge, head, post, repo, store } = await setup();
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const now = Date.now();
    const [entry] = localEntries(store, { now });
    assert.equal(entry.story.approved_head, head());
    assert.ok(entry.story.reviewed_at);
    assert.equal(
      localEntries(store, { now: now + (APPROVED_DAYS + 1) * 24 * 3600 * 1000 })[0].story
        .approved_at,
      null,
      'a week on',
    );

    const review = new AutoReview(store, async () => ({ merged: false, why: null }), 0);
    review.kickLocal(localEntries(store, { now }), now);
    await review.idle();
    assert.equal(localStories(store, { now })[0].approved_head, head(), 'same head: kept');

    commit(repo, 'four.txt');
    review.kickLocal(localEntries(store, { now }), now + 1000);
    await review.idle();
    assert.equal(store.readState(id, 'approved.json', null), null, 'cleared');
    const after = localStories(store, { now })[0];
    assert.equal(after.approved_at, null);
    assert.equal(after.reviewed_at, null, 'the mark approving wrote went with it: back in Ready');
    void home;
  } finally {
    await bridge.close();
  }
});

test('an approved local story with no PR is Ready to ship, and any of working, a PR or a new head moves it', () => {
  const none = { sessions: [], agents: [], pr: null };
  const story = {
    reviewed: true,
    manualReviewedAt: null,
    unread: false,
    local: true,
    approved: true,
  };
  assert.equal(columnOf({ ...none, story }), 'ship');
  assert.equal(columnOf({ ...none, story: { ...story, unread: true } }), 'ship');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'working' }], story }), 'working');
  assert.equal(columnOf({ ...none, story: { ...story, approved: false } }), 'idle');
  assert.equal(
    columnOf({ ...none, story: { ...story, approved: false, reviewed: false } }),
    'ready',
  );
  // not a local story: approved means nothing to a PR story
  assert.equal(columnOf({ ...none, story: { ...story, local: false } }), 'idle');
});

test('the board shows an approved local story in Ready to ship with its time, and drops it when the head moves', async () => {
  const { id, bridge, head, post, repo } = await setup();
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const board = async () =>
      (
        await bridge.call<BoardData>('GET', '/api/board', undefined, {
          Authorization: `Bearer ${boardKey(TOKEN)}`,
        })
      ).body.lanes
        .flatMap((lane) => lane.cards)
        .find((card) => card.story?.id === id);
    const card = await board();
    assert.equal(card?.column, 'ship');
    assert.ok(card?.story?.approved_at);
    commit(repo, 'five.txt');
    await bridge.call('GET', `/api/stories/${id}/version`, undefined, {
      Authorization: `Bearer ${pageKey(TOKEN, id)}`,
    }); // a page polling the story remakes its diff at the new head
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the board's snapshot is kept 2 s
    assert.equal((await board())?.column, 'ready');
  } finally {
    await bridge.close();
  }
});

test('once-upon approve approves at the current head, tells a story listener only, and --undo clears it', async () => {
  const { home, id, bridge, head, store, repo } = await setup();
  try {
    writeJson(path.join(home, 'config.json'), { port: 1, token: TOKEN });
    const done = await runCli(home, ['approve', id]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /approved at/);
    assert.equal(approvalOf(store, id, head())?.head_oid, head());
    assert.match((await runCli(home, ['approve', id])).stdout, /already approved/);

    // the story's listener hears it, and a repo listener leaves it to that one
    const wait = (...args: string[]) =>
      runCli(home, ['wait', ...args, '--type', 'approved', '--timeout', '1', '--json']);
    const types = (out: string) =>
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as Printable).type);
    // a first wait starts from now, so ask once to set the cursor, then approve a new head
    await wait('--story', id, '--consumer', `story-${id}`);
    commit(repo, 'six.txt');
    assert.equal((await runCli(home, ['approve', id])).code, 0);
    const heard = await wait('--story', id, '--consumer', `story-${id}`);
    assert.deepEqual(types(heard.stdout), ['approved']);
    assert.match(
      (await runCli(home, ['wait', '--story', id, '--consumer', 'x', '--timeout', '1'])).stdout,
      /^$/,
      'a wait with no cursor yet starts from now',
    );

    const undone = await runCli(home, ['approve', id, '--undo']);
    assert.match(undone.stdout, /approval cleared/);
    assert.equal(store.readState(id, 'approved.json', null), null);
    assert.notEqual((await runCli(home, ['approve', 'nope'])).code, 0);
  } finally {
    await bridge.close();
  }
});

const squashed =
  (head: () => string): BranchCheck =>
  async () => ({
    number: 7001,
    state: 'merged',
    merged_at: new Date().toISOString(),
    head_oid: head(),
  });

test('a squash-merged PR ships an approved story, which the default branch never contains', async () => {
  const { id, bridge, head, post, store } = await setup();
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const now = Date.now();
    const run = async (check: BranchCheck) => {
      const review = new AutoReview(store, async () => ({ merged: false, why: null }), 0, check);
      review.kickLocal(localEntries(store, { now }), now); // asks GitHub
      await review.idle();
      review.kickLocal(localEntries(store, { now }), now + 1);
      await review.idle();
    };
    // a merged PR that stopped short of the approved head shipped something else
    await run(async () => ({
      number: 7001,
      state: 'merged',
      merged_at: new Date(now).toISOString(),
      head_oid: '0'.repeat(40),
    }));
    assert.equal(approvalOf(store, id, head())?.head_oid, head(), 'still approved');
    await run(async () => ({ number: 7001, state: 'open', merged_at: null }));
    assert.equal(approvalOf(store, id, head())?.head_oid, head(), 'an open PR leaves it');
    await run(squashed(head));
    assert.equal(store.readState(id, 'approved.json', null), null, 'cleared');
    const after = localStories(store, { now })[0];
    assert.equal(after.approved_at, null);
    assert.equal(after.reviewed_by, 'pr');
  } finally {
    await bridge.close();
  }
});

test('approve --undo on a squash-merged story does not strand it in Ready: the PR check still finds it done', async () => {
  const { id, bridge, head, post, store } = await setup();
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { approved: false });
    const now = Date.now();
    assert.equal(localStories(store, { now })[0].reviewed_at, null, 'back in Ready');
    const review = new AutoReview(
      store,
      async () => ({ merged: false, why: null }),
      0,
      squashed(head),
    );
    review.kickLocal(localEntries(store, { now }), now);
    await review.idle();
    review.kickLocal(localEntries(store, { now }), now + 1);
    await review.idle();
    assert.equal(localStories(store, { now })[0].reviewed_by, 'pr');
    // an unmark by hand before approving comes back with the unapprove
    store.writeState(id, 'reviewed.json', { at: null, by: 'manual' });
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { approved: false });
    assert.deepEqual(store.readState(id, 'reviewed.json', null), { at: null, by: 'manual' });
  } finally {
    await bridge.close();
  }
});

test('the card of an approved story whose PR was squash-merged is linked to that PR, so it leaves Ready to ship', async () => {
  const { id, bridge, head, post } = await setup({ checkBranch: squashed(() => head()) });
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const card = async () =>
      (
        await bridge.call<BoardData>('GET', '/api/board', undefined, {
          Authorization: `Bearer ${boardKey(TOKEN)}`,
        })
      ).body.lanes
        .flatMap((lane) => lane.cards)
        .find((one) => one.story?.id === id || one.pr?.number === 7001);
    assert.equal((await card())?.column, 'ship', 'before GitHub has answered');
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the board's snapshot is kept 2 s
    const linked = await card();
    assert.equal(linked?.pr?.number, 7001);
    assert.equal(linked?.pr?.state, 'merged');
    assert.equal(linked?.column, 'done');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal((await card())?.story?.approved_at ?? null, null, 'and the approval is gone');
  } finally {
    await bridge.close();
  }
});

test('a merged PR is taken for an approved story by its head alone, so a deleted branch still ships it', async () => {
  const { id, bridge, head, post, store } = await setup();
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const now = Date.now();
    // what ghBranchCheck does once the caller names the story's heads: the branch need not exist
    const review = new AutoReview(
      store,
      async () => ({ merged: false, why: null }),
      0,
      async (_repo, _branch, _checkout, heads = []) =>
        heads.includes(head())
          ? {
              number: 7001,
              state: 'merged',
              merged_at: new Date(now).toISOString(),
              head_oid: head(),
            }
          : null,
    );
    review.kickLocal(localEntries(store, { now }), now);
    await review.idle();
    review.kickLocal(localEntries(store, { now }), now + 1);
    await review.idle();
    assert.equal(store.readState(id, 'approved.json', null), null);
    assert.equal(localStories(store, { now })[0].reviewed_by, 'pr');
  } finally {
    await bridge.close();
  }
});

test('a branch that went on after an older PR merged keeps the approved story on the board, in Ready to ship', async () => {
  const { id, bridge, head, post } = await setup({
    checkBranch: async () => ({
      number: 6000,
      state: 'merged',
      merged_at: '2026-10-01T00:00:00Z',
      head_oid: '0'.repeat(40),
    }),
  });
  try {
    await post(pageKey(TOKEN, id), `/api/stories/${id}/approve`, { head_sha: head() });
    const card = async () =>
      (
        await bridge.call<BoardData>('GET', '/api/board', undefined, {
          Authorization: `Bearer ${boardKey(TOKEN)}`,
        })
      ).body.lanes
        .flatMap((lane) => lane.cards)
        .find((one) => one.story?.id === id);
    await card();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const after = await card();
    assert.equal(after?.column, 'ship');
    assert.equal(after?.pr, null, 'the old PR is not this story’s');
  } finally {
    await bridge.close();
  }
});
