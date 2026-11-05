/**
 * POST /api/github/refresh: the extension saw you act on GitHub, so what the bridge read about that branch's PR is stale and
 * the board's next build asks GitHub again (and the board sees the answer on its next read, not 3 minutes later). The real
 * bridge, AutoReview and Board run here against a fake GitHub (the three checks), never the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, git, writeJson, startBridge, TOKEN } from './helpers.ts';
import { Board } from '../src/services/board/board.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { AutoReview, LIST_GAP_MS, REFRESH_GAP_MS } from '../src/services/review/github-watcher.ts';
import type { BranchPr, PrFacts } from '../src/services/review/github-checks.ts';
import { noPrWatcher, type PrWatcher } from '../src/services/board/stages/pr-watcher.ts';
import { boardKey } from '../src/services/pages/page-key.ts';
import { EXTENSION_ROUTES } from '../../extension/src/bridge-routes.ts';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import type { BoardCard, InboxStory, PrInfo } from '@once-upon-a-diff/contracts/types';
import type { StatusSource } from '../src/adapters/status-source.ts';

const HEAD = '7c3010541aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'fix/dot-prop';
const REPO = 'Acme/Widgets';
const OPEN: BranchPr = { number: 3092, state: 'open', merged_at: null };

const prInfo = (extra: Partial<PrInfo> = {}): PrInfo => ({
  number: 3092,
  url: `https://github.com/${REPO}/pull/3092`,
  title: 'PR 3092',
  state: 'open',
  draft: false,
  branch: BRANCH,
  author: 'octocat',
  mine: true,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
  ...extra,
});

/** What the fake GitHub says now, and how often it was asked. A test changes it between calls. */
const github = () => ({
  branch: null as BranchPr | null,
  info: prInfo(),
  requested: [] as { repo: string; number: number }[],
  asked: { branch: 0, info: 0, requested: 0 },
});

/** A bridge over a home with an approved local story on BRANCH (Ready to ship until the branch has a PR), against `hub`. */
async function world(hub: ReturnType<typeof github>, { prStory = false } = {}) {
  const home = tmp('refresh-home');
  const checkout = tmp('refresh-checkout');
  git(checkout, 'init', '-q', '-b', BRANCH);
  git(checkout, 'remote', 'add', 'origin', `git@github.com:${REPO}.git`);
  const id = 'local-dot-prop';
  const built = new Date(Date.now() - 3600000).toISOString();
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: checkout,
    repo_name: 'widgets',
    base: 'origin/main',
    head: 'HEAD',
    branch: BRANCH,
    title: 'Local dot-prop',
    built_at: built,
    head_oid: HEAD,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: 'dot-prop', chapters: [] });
  writeJson(path.join(home, 'state', id, 'approved.json'), {
    at: built,
    head_oid: HEAD,
    base_oid: null,
    marked: true,
  });
  writeJson(path.join(home, 'state', id, 'reviewed.json'), { at: built, by: 'approved' });
  if (prStory) {
    writeJson(path.join(home, 'pr-3092', 'meta.json'), {
      kind: 'github',
      repo: REPO,
      number: 3092,
      pr_title: 'PR 3092',
    });
    writeJson(path.join(home, 'pr-3092', 'chapters.json'), { title: 'pr', chapters: [] });
  }
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number): Promise<PrFacts> => {
      hub.asked.info += 1;
      return { merged: false, why: null, info: { ...hub.info, number } };
    },
    checkBranch: async () => {
      hub.asked.branch += 1;
      return hub.branch;
    },
    checkRequested: async () => {
      hub.asked.requested += 1;
      return hub.requested;
    },
  });
  const cards = async (): Promise<BoardCard[]> => {
    const board = await bridge.call<{ lanes: { cards: BoardCard[] }[] }>('GET', '/api/board');
    return board.body.lanes.flatMap((lane) => lane.cards);
  };
  /** the board read, and GitHub's answers to it landed, so the next read has them */
  const settle = async () => {
    await cards();
    await bridge.server.autoReview.idle();
    bridge.server.board.refresh();
    return cards();
  };
  const refresh = (body: unknown, headers?: Record<string, string>) =>
    bridge.call<{ ok?: boolean; refreshed?: boolean; settled?: boolean; error?: string }>(
      'POST',
      '/api/github/refresh',
      body,
      headers,
    );
  return { bridge, cards, settle, refresh };
}

test('opening a PR: the card moves on the refresh, not 3 minutes later', async () => {
  const hub = github();
  const sim = await world(hub);
  try {
    const before = await sim.settle();
    assert.deepEqual(
      before.map((card) => [card.column, card.pr?.number]),
      [['ship', undefined]],
    );
    // the PR is opened on GitHub: nothing changes on the board while its answers are kept
    hub.branch = OPEN;
    assert.equal((await sim.cards())[0].column, 'ship');
    const asked = { ...hub.asked };
    const answer = await sim.refresh({ repo: REPO, branch: BRANCH, reason: 'open' });
    assert.deepEqual(
      [answer.status, answer.body.refreshed, answer.body.settled],
      [200, true, true],
    );
    // GitHub was asked about the branch again, once, and the very next read has the PR
    assert.equal(hub.asked.branch, asked.branch + 1);
    const after = await sim.cards();
    assert.deepEqual(
      after.map((card) => [card.column, card.pr?.number]),
      [['pr_open', 3092]],
    );
  } finally {
    await sim.bridge.close();
  }
});

test('a review: the PR check is asked again and its new facts show on the card', async () => {
  const hub = github();
  hub.branch = OPEN;
  hub.requested = [{ repo: REPO, number: 3092 }];
  const sim = await world(hub, { prStory: true });
  try {
    const before = (await sim.settle()).find((card) => card.pr?.number === 3092);
    assert.equal(before?.pr?.approvals, 0);
    hub.info = prInfo({ approvals: 1, review: 'approved' });
    assert.equal((await sim.cards()).find((card) => card.pr)?.pr?.approvals, 0, 'kept answers');
    // by number alone: the bridge knows the PR's branch from what it kept
    const answer = await sim.refresh({ repo: REPO, number: 3092, reason: 'review' });
    assert.equal(answer.body.refreshed, true);
    const after = (await sim.cards()).find((card) => card.pr?.number === 3092);
    assert.deepEqual([after?.pr?.approvals, after?.pr?.review], [1, 'approved']);
  } finally {
    await sim.bridge.close();
  }
});

test('a burst is one refresh; the second ping after the gap asks again; the lists have their own gap', async () => {
  const hub = github();
  const sim = await world(hub);
  try {
    await sim.settle();
    const first = await sim.refresh({ repo: REPO, branch: BRANCH, reason: 'open' });
    assert.equal(first.body.refreshed, true);
    const asked = { ...hub.asked };
    const again = await sim.refresh({ repo: REPO, branch: BRANCH, reason: 'open' });
    assert.deepEqual([again.status, again.body.refreshed], [200, false]);
    assert.deepEqual(hub.asked, asked, 'a repeat inside the gap asks GitHub nothing');
    // another branch right away: its own refresh, but the lists (one search) are not asked again so soon
    const other = await sim.refresh({ repo: REPO, branch: 'feature/other', reason: 'open' });
    assert.equal(other.body.refreshed, true);
    assert.equal(hub.asked.requested, asked.requested, 'the lists have their own, longer gap');
  } finally {
    await sim.bridge.close();
  }
});

test('a ping for a repo the board follows nothing in does nothing: no rebuild, no search, no held request', async () => {
  const hub = github();
  const sim = await world(hub);
  try {
    await sim.settle();
    const asked = { ...hub.asked };
    const started = Date.now();
    const answer = await sim.refresh({ repo: 'someone/else', number: 12, reason: 'merge' });
    assert.deepEqual([answer.status, answer.body.refreshed], [200, false]);
    assert.deepEqual(hub.asked, asked, 'GitHub was asked nothing, the lists included');
    assert.ok(Date.now() - started < 2000);
    // a branch of a followed repo that has no entry of its own still refreshes the repo's lists
    const known = await sim.refresh({ repo: REPO, branch: 'feature/new', reason: 'open' });
    assert.equal(known.body.refreshed, true);
    assert.equal(hub.asked.requested, asked.requested + 1);
  } finally {
    await sim.bridge.close();
  }
});

test('the body is checked, and only the extension’s token reaches it', async () => {
  const sim = await world(github());
  try {
    const bad: [unknown, string][] = [
      [{ repo: 'nope', branch: BRANCH, reason: 'open' }, 'bad repo'],
      [{ repo: REPO, branch: 'has space', reason: 'open' }, 'bad branch'],
      [{ repo: REPO, branch: 'a'.repeat(256), reason: 'open' }, 'bad branch'],
      [{ repo: REPO, branch: 'a\nb', reason: 'open' }, 'bad branch'],
      [{ repo: REPO, number: 0, reason: 'review' }, 'bad number'],
      [{ repo: REPO, number: 1.5, reason: 'review' }, 'bad number'],
      [{ repo: REPO, reason: 'review' }, 'a branch or a PR number is needed'],
      [{ repo: REPO, branch: BRANCH, reason: 'delete-everything' }, 'reason is not valid'],
      [{ branch: BRANCH, reason: 'open' }, 'bad repo'],
    ];
    for (const [body, message] of bad) {
      const answer = await sim.refresh(body);
      assert.deepEqual([answer.status, answer.body.error], [400, message], JSON.stringify(body));
    }
    // no token: 401. the board page's key: 403 (it is the token's route only)
    const none = await sim.refresh(
      { repo: REPO, branch: BRANCH, reason: 'open' },
      { Authorization: '' },
    );
    assert.equal(none.status, 401);
    const board = await sim.refresh(
      { repo: REPO, branch: BRANCH, reason: 'open' },
      { Authorization: `Bearer ${boardKey(TOKEN)}` },
    );
    assert.equal(board.status, 403);
    // and the extension's service worker may forward it
    assert.ok(EXTENSION_ROUTES.includes(ROUTES.githubRefresh));
    assert.equal(ROUTES.githubRefresh.keys, 'token');
  } finally {
    await sim.bridge.close();
  }
});

test('more than 20 a minute is refused, and the board holds still', async () => {
  const hub = github();
  const sim = await world(hub);
  try {
    await sim.settle();
    for (let one = 0; one < 20; one++) {
      const answer = await sim.refresh({ repo: REPO, branch: `feature/${one}`, reason: 'open' });
      assert.equal(answer.status, 200, `refresh ${one}`);
    }
    const asked = { ...hub.asked };
    const over = await sim.refresh({ repo: REPO, branch: 'feature/21', reason: 'open' });
    assert.equal(over.status, 429);
    assert.deepEqual(hub.asked, asked);
  } finally {
    await sim.bridge.close();
  }
});

test('Board.rebuild never answers with a build that started before it', async () => {
  const home = tmp('rebuild-home');
  // a status source we hold: the build is in flight (before it reads the works) until released
  let release = () => {};
  let held: Promise<void> | null = new Promise<void>((resolve) => (release = resolve));
  const source: StatusSource = {
    name: 'iterm',
    statuses: async () => {
      await held;
      return new Map();
    },
  };
  let reads = 0;
  const watcher: PrWatcher = { ...noPrWatcher, kickRequested: () => void (reads += 1) };
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), { source });
  const running = board.snapshot();
  const rebuilt = board.rebuild();
  held = null;
  release();
  await Promise.all([running, rebuilt]);
  // the running build (reads 1) was waited out and not used: a second build, started after, made the answer
  assert.equal(reads, 2);
});

test('a refresh while a board build is running still makes GitHub be asked', async () => {
  const hub = github();
  const sim = await world(hub);
  try {
    await sim.settle();
    hub.branch = OPEN;
    // a poll's build is in flight when the ping arrives (the board's kept answer is dropped first, as a poll would find it)
    sim.bridge.server.board.refresh();
    const poll = sim.cards();
    const asked = hub.asked.branch;
    const answer = await sim.refresh({ repo: REPO, branch: BRANCH, reason: 'open' });
    await poll;
    assert.equal(answer.body.settled, true);
    assert.equal(hub.asked.branch, asked + 1);
    assert.equal((await sim.cards())[0].pr?.number, 3092);
  } finally {
    await sim.bridge.close();
  }
});

const story = (number: number): InboxStory => ({
  id: `pr-${number}`,
  repo: REPO,
  number,
  title: `PR ${number}`,
  branch: BRANCH,
  url: `https://github.com/${REPO}/pull/${number}`,
  built_at: new Date(0).toISOString(),
  seen_at: null,
  reviewed_at: null,
  reviewed_by: null,
});

test('the newest ask wins: an older answer finishing later does not overwrite a refresh’s', async () => {
  const releases: (() => void)[] = [];
  const infos = [prInfo({ approvals: 0 }), prInfo({ approvals: 2, review: 'approved' })];
  let asks = 0;
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => {
      const mine = infos[asks++];
      await new Promise<void>((resolve) => releases.push(resolve));
      return { merged: false, why: null, info: mine };
    },
    1000,
  );
  review.kick([story(3092)], 1000);
  // you act on GitHub while the first ask is out: a refresh asks again, and this answer comes back first
  assert.equal(review.refresh({ repo: REPO, number: 3092 }, 1500), true);
  review.kick([story(3092)], 1600);
  assert.equal(asks, 2);
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  releases[0]();
  await review.idle();
  assert.equal(review.info(REPO, 3092)?.approvals, 2, 'the older answer was dropped');
});

test('the lists too: only the newest ask writes them, and a refresh asks again after its own gap', async () => {
  const START = 1_700_000_000_000; // a real clock: a stale mark (at 0) is older than any window
  const releases: (() => void)[] = [];
  const answers = [[{ repo: REPO, number: 1 }], [{ repo: REPO, number: 2 }]];
  let asks = 0;
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
    async () => {
      const mine = answers[asks++] ?? [];
      await new Promise<void>((resolve) => releases.push(resolve));
      return mine;
    },
  );
  review.kickRequested(START + 1000);
  review.kickBranch(REPO, 'x', '/nowhere', START + 1000); // the repo is one the board follows
  review.refresh({ repo: REPO, branch: 'x' }, START + 1100);
  review.kickRequested(START + 1200);
  assert.equal(asks, 2);
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  releases[0]();
  await review.idle();
  assert.deepEqual(review.requested(), [{ repo: REPO, number: 2 }]);
  // the lists' gap: a second refresh for another branch inside it leaves them alone, one after it makes them stale again
  assert.equal(review.refresh({ repo: REPO, branch: 'y' }, START + 1100 + LIST_GAP_MS - 1), true);
  review.kickRequested(START + 1100 + LIST_GAP_MS);
  assert.equal(asks, 2, 'inside the gap: not asked');
  assert.equal(review.refresh({ repo: REPO, branch: 'z' }, START + 1100 + LIST_GAP_MS), true);
  review.kickRequested(START + 1100 + LIST_GAP_MS + 1);
  assert.equal(asks, 3, 'after the gap: asked again');
  releases[2]();
  await review.idle();
});

test('a refresh keeps the old answers until the new ones land, and a failed ask keeps them', async () => {
  let fail = false;
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => {
      if (fail) {
        throw new Error('gh: HTTP 502');
      }
      return { merged: false, why: null, info: prInfo({ approvals: 1 }) };
    },
    1000,
    async () => {
      if (fail) {
        throw new Error('gh: HTTP 502');
      }
      return OPEN;
    },
  );
  review.kick([story(3092)], 1000);
  review.kickBranch(REPO, BRANCH, '/nowhere', 1000);
  await review.idle();
  fail = true;
  assert.equal(review.refresh({ repo: REPO, branch: BRANCH }, 1100), true);
  assert.equal(review.info(REPO, 3092)?.approvals, 1, 'still there before the new ask');
  review.kick([story(3092)], 1200);
  review.kickBranch(REPO, BRANCH, '/nowhere', 1200);
  await review.idle();
  assert.equal(review.info(REPO, 3092)?.approvals, 1);
  assert.deepEqual(review.branchPr(REPO, BRANCH), OPEN);
  assert.equal(REFRESH_GAP_MS, 2000);
});

test('refresh is false, and marks nothing, for a repo nothing was asked about', async () => {
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
    async () => [{ repo: 'Acme/Other', number: 5 }],
  );
  review.kickRequested(1_700_000_000_000);
  await review.idle();
  assert.equal(review.refresh({ repo: REPO, number: 1 }, 1_700_000_100_000), false);
  assert.equal(review.refresh({ repo: 'acme/other', number: 5 }, 1_700_000_100_000), true);
});

test('a branch answer that was asked before a refresh does not clear the refresh’s stale mark', async () => {
  const START = 1_700_000_000_000;
  const releases: (() => void)[] = [];
  let asks = 0;
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => ({ merged: false, why: null }),
    60000,
    async () => {
      asks += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return OPEN;
    },
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START);
  // you act on GitHub while that ask is out; it started before the action
  assert.equal(review.refresh({ repo: REPO, branch: BRANCH }, START + 100), true);
  releases[0]();
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), OPEN, 'its answer is still shown');
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 200);
  assert.equal(asks, 2, 'but the board asks again');
  releases[1]();
  await review.idle();
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 300);
  assert.equal(asks, 2, 'and that answer is fresh');
});

test('the lists too: an answer asked before a refresh does not clear its stale mark', async () => {
  const START = 1_700_000_000_000;
  const releases: (() => void)[] = [];
  let asks = 0;
  const review = new AutoReview(
    new StoryStore({ home: tmp('guard-home') }),
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
    async () => {
      asks += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return [{ repo: REPO, number: asks }];
    },
  );
  review.kickRequested(START);
  releases[0]();
  await review.idle();
  review.kickRequested(START + 60001); // the window is up: asked again, and this ask is out
  assert.equal(asks, 2);
  assert.equal(review.refresh({ repo: REPO, number: 1 }, START + 60100), true);
  releases[1]();
  await review.idle();
  review.kickRequested(START + 60200);
  assert.equal(asks, 3, 'the board asks again');
  releases[2]();
  await review.idle();
  assert.deepEqual(review.requested(), [{ repo: REPO, number: 3 }]);
});
