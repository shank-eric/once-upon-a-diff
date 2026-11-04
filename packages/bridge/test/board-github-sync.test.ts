/**
 * The board's GitHub sync: a local story whose branch has a PR leaves Ready to ship, a merged PR doesn't sit there, and
 * a GitHub answer that is late or failed leaves the board as it was. The real AutoReview runs here against a fake
 * GitHub source (the three checks), never the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, git, writeJson } from './helpers.ts';
import { Board } from '../src/services/board/board.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { AutoReview } from '../src/services/review/github-watcher.ts';
import type {
  BranchCheck,
  BranchPr,
  PrCheck,
  PrFacts,
  RequestedCheck,
} from '../src/services/review/github-checks.ts';
import type { BoardCard, PrInfo } from '@once-upon-a-diff/protocol/types';

const START = Date.parse('2026-11-03T20:50:00Z');
const HEAD = '7c3010541aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLDER = '9d9d9d9d9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'fix/dot-prop';
const REPO = 'Acme/Widgets';

const prInfo = (number: number, extra: Partial<PrInfo> = {}): PrInfo => ({
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  title: `PR ${number}`,
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

/** What the fake GitHub says; a test changes it between snapshots. `null` makes that ask fail, and `hold` leaves it in flight. */
interface Github {
  branch: BranchPr | null | 'fail';
  /** when set, what the branch check answers for the heads it is given (ghBranchCheck finds a merged PR only for those) */
  branchFor?: (heads: string[]) => BranchPr | null;
  info: PrInfo | 'fail';
  requested: { repo: string; number: number }[] | 'fail';
  hold: Promise<void> | null;
  asked: { branch: number; info: number; requested: number };
}

function world(
  github: Github,
  {
    older = false,
    prStory = false,
    mergedStory = false,
  }: { older?: boolean; prStory?: boolean; mergedStory?: boolean } = {},
) {
  const home = tmp('github-sync-home');
  const checkout = tmp('github-sync-checkout');
  git(checkout, 'init', '-q', '-b', BRANCH);
  git(checkout, 'remote', 'add', 'origin', `git@github.com:${REPO}.git`);
  const id = 'local-dot-prop';
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: checkout,
    repo_name: 'widgets',
    base: 'origin/main',
    head: 'HEAD',
    branch: BRANCH,
    title: 'Local dot-prop',
    built_at: new Date(START - 3600000).toISOString(),
    head_oid: HEAD,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: 'dot-prop', chapters: [] });
  writeJson(path.join(home, 'state', id, 'approved.json'), {
    at: new Date(START - 600000).toISOString(),
    head_oid: HEAD,
    base_oid: null,
    marked: true,
  });
  writeJson(path.join(home, 'state', id, 'reviewed.json'), {
    at: new Date(START - 600000).toISOString(),
    by: 'approved',
  });
  if (older) {
    // an older, unreviewed story of the same branch, at another commit
    writeJson(path.join(home, 'local-older', 'meta.json'), {
      kind: 'local',
      repo_path: checkout,
      repo_name: 'widgets',
      base: 'origin/main',
      head: 'HEAD',
      branch: BRANCH,
      title: 'Local older',
      built_at: new Date(START - 7200000).toISOString(),
      head_oid: OLDER,
    });
    writeJson(path.join(home, 'local-older', 'chapters.json'), { title: 'older', chapters: [] });
  }
  if (prStory) {
    // a PR story that doesn't say which branch the PR is from
    writeJson(path.join(home, 'pr-3092', 'meta.json'), {
      kind: 'github',
      repo: REPO,
      number: 3092,
      pr_title: 'PR 3092',
    });
    writeJson(path.join(home, 'pr-3092', 'chapters.json'), { title: 'pr', chapters: [] });
    if (mergedStory) {
      // the PR's story is marked merged a few minutes ago (a stale mark when GitHub says the PR is open again)
      writeJson(path.join(home, 'state', 'pr-3092', 'merged.json'), {
        at: new Date(START - 300000).toISOString(),
        why: 'merged',
        merged_at: new Date(START - 300000).toISOString(),
      });
    }
  }
  const stories = new StoryStore({ home });
  const wait = async () => {
    await github.hold;
  };
  const check: PrCheck = async (_repo, number): Promise<PrFacts> => {
    github.asked.info += 1;
    await wait();
    if (github.info === 'fail') {
      throw new Error('gh: HTTP 502');
    }
    const info = github.info;
    return { merged: info.state === 'merged', why: null, info: { ...info, number } };
  };
  const checkBranch: BranchCheck = async (_repo, _branch, _checkout, heads = []) => {
    github.asked.branch += 1;
    await wait();
    if (github.branchFor) {
      return github.branchFor(heads);
    }
    if (github.branch === 'fail') {
      throw new Error('gh: HTTP 502');
    }
    return github.branch;
  };
  const checkRequested: RequestedCheck = async () => {
    github.asked.requested += 1;
    await wait();
    if (github.requested === 'fail') {
      throw new Error('gh: HTTP 502');
    }
    return github.requested;
  };
  const review = new AutoReview(stories, check, 1000, checkBranch, checkRequested);
  let now = START;
  const board = new Board(home, stories, review, new Builds(home), { now: () => new Date(now) });
  return {
    review,
    /** a snapshot, then the GitHub asks it started finished, then the snapshot that reads their answers */
    async settle(): Promise<BoardCard[]> {
      await board.snapshot();
      await review.idle();
      now += 5000;
      const data = await board.snapshot();
      return data.lanes.flatMap((lane) => lane.cards);
    },
    /** one snapshot a while later (the kept answers are older than the cache), without waiting for GitHub */
    async later(): Promise<BoardCard[]> {
      now += 5000;
      return (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
    },
  };
}

const github = (extra: Partial<Github> = {}): Github => ({
  branch: null,
  info: prInfo(3092),
  requested: [],
  hold: null,
  asked: { branch: 0, info: 0, requested: 0 },
  ...extra,
});

const iso = (time: number) => new Date(time).toISOString();
const columns = (cards: BoardCard[]) =>
  cards.map((card) => [card.id, card.column, card.pr?.number]);

test('a local story whose branch has an open PR takes that PR and leaves Ready to ship', async () => {
  const sim = world(github({ branch: { number: 3092, state: 'open', merged_at: null } }));
  const cards = await sim.settle();
  assert.deepEqual(
    cards.map((card) => [card.column, card.pr?.number, card.story?.id]),
    [['pr_open', 3092, 'local-dot-prop']],
  );
});

test('the PR is also one of yours (the requested search lists it): one card, not a PR card and a Ready to ship card', async () => {
  const sim = world(
    github({
      branch: { number: 3092, state: 'open', merged_at: null },
      requested: [{ repo: REPO, number: 3092 }],
    }),
  );
  const cards = await sim.settle();
  assert.deepEqual(columns(cards), [[`pr:${REPO.toLowerCase()}#3092`, 'pr_open', 3092]]);
  assert.equal(cards[0].story?.id, 'local-dot-prop');
  // and while GitHub has not described the PR yet
  const early = world(
    github({
      branch: { number: 3092, state: 'open', merged_at: null },
      requested: [{ repo: REPO, number: 3092 }],
      info: 'fail',
    }),
  );
  const stub = await early.settle();
  assert.deepEqual(columns(stub), [[`pr:${REPO.toLowerCase()}#3092`, 'pr_open', 3092]]);
  assert.equal(stub[0].story?.id, 'local-dot-prop');
});

test('a story whose PR merged is not in Ready to ship', async () => {
  const merged = {
    number: 3092,
    state: 'merged' as const,
    merged_at: new Date(START - 60000).toISOString(),
    head_oid: HEAD,
  };
  const sim = world(
    github({
      branch: merged,
      info: prInfo(3092, { state: 'merged', merged_at: merged.merged_at }),
    }),
  );
  const cards = await sim.settle();
  assert.ok(!cards.some((card) => card.column === 'ship'), JSON.stringify(columns(cards)));
  // a merged PR the branch check hasn't found yet is the PR check's to say, when the board knows the PR
  const only = world(
    github({
      branch: { number: 3092, state: 'open', merged_at: null },
      requested: [{ repo: REPO, number: 3092 }],
      info: prInfo(3092, { state: 'merged', merged_at: merged.merged_at }),
    }),
  );
  assert.ok(!(await only.settle()).some((card) => card.column === 'ship'));
});

test('a failed or late GitHub answer leaves a card where it was', async () => {
  const hub = github({
    branch: { number: 3092, state: 'open', merged_at: null },
  });
  const sim = world(hub);
  const before = columns(await sim.settle());
  assert.deepEqual(
    before.map((card) => card[1]),
    ['pr_open'],
  );
  // every ask fails: the cached answers are past their window, so each is asked again, and the board holds still
  hub.branch = 'fail';
  hub.info = 'fail';
  hub.requested = 'fail';
  for (let round = 0; round < 3; round++) {
    await sim.later();
    await sim.review.idle();
    assert.deepEqual(columns(await sim.later()), before, `round ${round}`);
  }
  assert.ok(hub.asked.branch > 1 && hub.asked.requested > 1, 'they were asked again and failed');
  // and while an ask is in flight
  let release = () => {};
  hub.hold = new Promise<void>((resolve) => (release = resolve));
  hub.branch = { number: 3092, state: 'open', merged_at: null };
  hub.info = prInfo(3092);
  await sim.later();
  assert.deepEqual(columns(await sim.later()), before);
  release();
  await sim.review.idle();
  assert.deepEqual(columns(await sim.later()), before);
});

test('a branch answer asked without a story’s head is asked again for a caller that has one', async () => {
  // what ghBranchCheck does: a merged PR counts only when its head is one the asker gave (or the branch has it)
  const merged: BranchPr = { number: 3092, state: 'merged', merged_at: iso(START), head_oid: HEAD };
  const asks: string[][] = [];
  const check: BranchCheck = async (_repo, _branch, _checkout, heads = []) => {
    asks.push(heads);
    return heads.includes(HEAD) ? merged : null;
  };
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-sync-home') }),
    async () => {
      throw new Error('not asked');
    },
    1000,
    check,
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START);
  await review.idle();
  assert.equal(review.branchPr(REPO, BRANCH), null);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, []);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 20, [HEAD]);
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), merged);
  // an answer is not asked for again by callers it already covers, with or without heads
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 30, [HEAD]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 40);
  await review.idle();
  assert.deepEqual(asks, [[], [HEAD]]);
  // a failed ask keeps the answer
  const failing = new AutoReview(
    new StoryStore({ home: tmp('github-sync-home') }),
    async () => {
      throw new Error('not asked');
    },
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      if (asks.length > 2) {
        throw new Error('gh: HTTP 502');
      }
      asks.push(heads);
      return merged;
    },
  );
  failing.kickBranch(REPO, BRANCH, '/nowhere', START, [HEAD]);
  await failing.idle();
  failing.kickBranch(REPO, BRANCH, '/nowhere', START + 5000, [HEAD]);
  await failing.idle();
  assert.deepEqual(failing.branchPr(REPO, BRANCH), merged);
});

test('an approved story and an older one on the same branch: the PR squash-merged at the approved head, the local branch gone', async () => {
  const merged: BranchPr = {
    number: 3092,
    state: 'merged',
    merged_at: iso(START - 60000),
    head_oid: HEAD,
  };
  const hub = github({
    // ghBranchCheck: a merged PR is found only for a head the asker gave, and the branch is deleted here
    branchFor: (heads) => (heads.includes(HEAD) ? merged : null),
    info: prInfo(3092, { state: 'merged', merged_at: merged.merged_at }),
  });
  const cards = await world(hub, { older: true }).settle();
  assert.ok(!cards.some((card) => card.column === 'ship'), JSON.stringify(columns(cards)));
});

test('overlapping branch asks: a late "none" does not replace a newer merged answer, and every ask carries every head', async () => {
  const merged: BranchPr = { number: 3092, state: 'merged', merged_at: iso(START), head_oid: HEAD };
  const releases: (() => void)[] = [];
  const seen: string[][] = [];
  const check: BranchCheck = async (_repo, _branch, _checkout, heads = []) => {
    seen.push(heads);
    await new Promise<void>((resolve) => releases.push(resolve));
    return heads.includes(HEAD) ? merged : null;
  };
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-sync-home') }),
    async () => {
      throw new Error('not asked');
    },
    1000,
    check,
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START, [OLDER]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [HEAD]);
  assert.deepEqual(seen, [[OLDER], [OLDER, HEAD]]);
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  releases[0]();
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), merged);
});

test('an open PR whose work already has a PR story: the branch card goes, the PR story stays', async () => {
  const hub = github({
    branch: { number: 3092, state: 'open', merged_at: null },
    info: 'fail',
  });
  const cards = await world(hub, { prStory: true }).settle();
  assert.deepEqual(
    cards.map((card) => [card.pr?.number, card.story?.id, card.column === 'ship']),
    [[3092, 'pr-3092', false]],
  );
});

test('a commit GitHub added after approval: the PR squash-merged at another commit is found, the approved story leaves Ready to ship', async () => {
  const merged: BranchPr = {
    number: 3092,
    state: 'merged',
    merged_at: iso(START - 60000),
    head_oid: 'b4b4b4b4baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shipped: [HEAD],
  };
  // ghBranchCheck: the PR's last commit is not the approved head, but the approved head is among its commits
  const hub = github({
    branchFor: (heads) => (heads.includes(HEAD) ? merged : null),
    info: 'fail',
  });
  const cards = await world(hub).settle();
  assert.ok(!cards.some((card) => card.column === 'ship'), JSON.stringify(columns(cards)));
  assert.deepEqual(
    cards.map((card) => [card.pr?.number, card.story?.id]),
    [[3092, 'local-dot-prop']],
  );
});

test('an older branch ask that finishes while a newer one is in flight does not shrink what the newer one covers', async () => {
  const releases: (() => void)[] = [];
  const seen: string[][] = [];
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-sync-home') }),
    async () => {
      throw new Error('not asked');
    },
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      seen.push(heads);
      await new Promise<void>((resolve) => releases.push(resolve));
      return null;
    },
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START, [OLDER]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [HEAD]);
  assert.deepEqual(seen, [[OLDER], [OLDER, HEAD]]);
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  // the newer ask covers both heads and is still running: a caller with either head needs no third ask
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 20, [HEAD]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 30, [OLDER]);
  assert.deepEqual(seen, [[OLDER], [OLDER, HEAD]]);
  releases[1]();
  await review.idle();
  assert.equal(review.branchPr(REPO, BRANCH), null);
});

test('an open PR whose work carries a stale merged mark: the branch card goes and the approved story stays on the PR', async () => {
  const hub = github({
    branch: { number: 3092, state: 'open', merged_at: null },
    info: 'fail',
  });
  const cards = await world(hub, { prStory: true, mergedStory: true }).settle();
  assert.deepEqual(
    cards.map((card) => [card.pr?.number, card.story?.id, card.column === 'ship']),
    [[3092, 'local-dot-prop', false]],
  );
});
