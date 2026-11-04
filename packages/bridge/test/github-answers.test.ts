/**
 * What GitHub last said is kept in <home>/github-answers.json, so a bridge that restarts shows the last known state (a
 * story approved with an open PR is in PR open, not Ready to ship) and asks GitHub again at once. Loaded answers are only
 * for display until this run's own answer lands. The real AutoReview and Board run against a fake GitHub, never the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, git, writeJson } from './helpers.ts';
import { Board } from '../src/services/board/board.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import {
  AutoReview,
  type BranchCheck,
  type BranchPr,
  type PrCheck,
  type RequestedCheck,
} from '../src/services/review/auto-review.ts';
import {
  KEEP_MS,
  readGithubAnswers,
  writeGithubAnswers,
} from '../src/adapters/stores/github-answers.ts';
import type { BoardCard, PrInfo } from '@once-upon-a-diff/protocol/types';

const START = Date.now();
const HEAD = '7c3010541aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '9d9d9d9d9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'fix/dot-prop';
const REPO = 'Acme/Widgets';
const OPEN: BranchPr = { number: 3092, state: 'open', merged_at: null };
const MERGED: BranchPr = {
  number: 3092,
  state: 'merged',
  merged_at: new Date(START - 60000).toISOString(),
  head_oid: HEAD,
};
const KEY = `${REPO.toLowerCase()}@${BRANCH}`;

const prInfo = (number = 3092): PrInfo => ({
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  branch: BRANCH,
  author: 'octocat',
  mine: true,
  review_requested: false,
  approvals: 1,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
});

const files = (home: string) => path.join(home, 'github-answers.json');
const idle = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise<never>(() => undefined);
const noPr: PrCheck = async () => {
  throw new Error('not asked');
};

interface Fake {
  hold: Promise<void> | null;
  asked: number;
  fail: boolean;
  answer: BranchPr | null;
  check: BranchCheck;
}

function fake(): Fake {
  const state: Fake = {
    hold: null,
    asked: 0,
    fail: false,
    answer: OPEN,
    check: async () => {
      state.asked += 1;
      await state.hold;
      if (state.fail) {
        throw new Error('gh: HTTP 502');
      }
      return state.answer;
    },
  };
  return state;
}

/** A home with one local story on BRANCH (approved, or not), a checkout, and a Board over a fresh AutoReview on that home. */
function world(home: string, hub: Fake, { approved = true } = {}) {
  const checkout = tmp('github-answers-checkout');
  git(checkout, 'init', '-q', '-b', BRANCH);
  git(checkout, 'remote', 'add', 'origin', `git@github.com:${REPO}.git`);
  const id = 'local-dot-prop';
  if (!existsSync(path.join(home, id))) {
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
    if (approved) {
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
    }
  }
  const stories = new StoryStore({ home });
  const requested: RequestedCheck = async () => [];
  const review = new AutoReview(stories, noPr, 1000, hub.check, requested, home);
  let now = START;
  const board = new Board(home, stories, review, new Builds(home), { now: () => new Date(now) });
  return {
    review,
    async cards(): Promise<BoardCard[]> {
      now += 5000;
      return (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
    },
  };
}

const columns = (cards: BoardCard[]) => cards.map((card) => [card.column, card.pr?.number]);

test('a restart shows the last known PR at once, and the first kick asks GitHub again', async () => {
  const home = tmp('github-answers-home');
  const hub = fake();
  const first = world(home, hub);
  await first.cards();
  await first.review.idle();
  assert.deepEqual(columns(await first.cards()), [['pr_open', 3092]]);
  // the answers are in the file, written whole (no temp file left behind)
  const saved = JSON.parse(readFileSync(files(home), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.branches[KEY].pr.number, 3092);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith('.tmp')),
    [],
  );
  // a new bridge on the same home, GitHub slow to answer: not Ready to ship, and it asked
  const slow = fake();
  slow.hold = new Promise<void>(() => undefined);
  const second = world(home, slow);
  assert.deepEqual(columns(await second.cards()), [['pr_open', 3092]]);
  assert.ok(slow.asked > 0, 'the loaded answer is last known, not fresh: GitHub is asked at once');
  // and without the file the card is where the bug put it
  const bare = world(tmp('github-answers-home'), fake());
  assert.equal(second.review.branchPr(REPO, BRANCH)?.number, 3092);
  assert.deepEqual(
    columns(await bare.cards()).map((card) => card[0]),
    ['ship'],
  );
});

test('a loaded answer is display only: no done mark from it, until this run’s own answer lands', async () => {
  const home = tmp('github-answers-home');
  writeGithubAnswers(home, {
    branches: { [KEY]: { at: START - 1000, pr: OPEN } },
    prs: {},
    requested: null,
  });
  const reviewed = path.join(home, 'state', 'local-dot-prop', 'reviewed.json');
  const hub = fake();
  let release = () => {};
  hub.hold = new Promise<void>((resolve) => (release = resolve));
  // not approved: a PR for its branch is what marks it done (by `pr`)
  const sim = world(home, hub, { approved: false });
  await sim.cards();
  await sim.cards();
  assert.equal(sim.review.branchPr(REPO, BRANCH)?.number, 3092, 'shown');
  assert.equal(existsSync(reviewed), false, 'but not marked from the loaded answer');
  // GitHub says there is none: still no mark
  hub.answer = null;
  release();
  await sim.review.idle();
  await sim.cards();
  await sim.review.idle();
  assert.equal(existsSync(reviewed), false);
  // a fresh open answer does mark it, as it always did
  hub.answer = OPEN;
  await sim.cards();
  await sim.review.idle();
  await sim.cards();
  assert.equal(JSON.parse(readFileSync(reviewed, 'utf8')).by, 'pr');
});

test('a missing, broken, other-version or expired file reads as empty; one good entry among bad ones is kept', () => {
  const home = tmp('github-answers-home');
  const empty = { branches: {}, prs: {}, requested: null };
  assert.deepEqual(readGithubAnswers(home), empty);
  writeFileSync(files(home), '{ not json');
  assert.deepEqual(readGithubAnswers(home), empty);
  writeJson(files(home), { version: 2, branches: { [KEY]: { at: START, pr: OPEN } } });
  assert.deepEqual(readGithubAnswers(home), empty);
  writeJson(files(home), {
    version: 1,
    branches: {
      [KEY]: { at: START, pr: OPEN },
      bad: { at: START, pr: { number: 'x', state: 'open', merged_at: null } },
      weird: { at: START, pr: { number: 1, state: 'closed', merged_at: null } },
      old: { at: START - KEEP_MS - 1, pr: OPEN },
      none: { at: START, pr: null },
    },
    prs: { 'a/b#1': { at: START, info: { number: 'x' } }, 'a/b#2': { at: START, info: prInfo(2) } },
    requested: { at: START - KEEP_MS - 1, list: [] },
  });
  const read = readGithubAnswers(home, START);
  assert.deepEqual(Object.keys(read.branches).sort(), ['none', KEY].sort());
  assert.deepEqual(Object.keys(read.prs), ['a/b#2']);
  assert.equal(read.requested, null, 'a week old');
  // a bridge that starts on it shows only the good entries
  const review = new AutoReview(
    new StoryStore({ home }),
    noPr,
    1000,
    fake().check,
    undefined,
    home,
  );
  assert.equal(review.branchPr(REPO, BRANCH)?.number, 3092);
  assert.equal(review.branchPr('a', 'old'), undefined);
});

test('writes drop entries older than a week and leave no temp file', () => {
  const home = tmp('github-answers-home');
  writeGithubAnswers(
    home,
    {
      branches: { new: { at: START, pr: OPEN }, old: { at: START - KEEP_MS - 1, pr: OPEN } },
      prs: { 'a/b#2': { at: START - KEEP_MS - 1, info: prInfo(2) } },
      requested: { at: START, list: [{ repo: REPO, number: 1 }] },
    },
    START,
  );
  const read = readGithubAnswers(home, START);
  assert.deepEqual(Object.keys(read.branches), ['new']);
  assert.deepEqual(read.prs, {});
  assert.deepEqual(read.requested?.list, [{ repo: REPO, number: 1 }]);
  assert.deepEqual(readdirSync(home), ['github-answers.json']);
  // a home that is gone is not an error
  writeGithubAnswers(path.join(home, 'gone', 'deeper'), read, START);
});

test('a failed ask keeps the loaded answer and the file; the answer, the PR info and the lists round trip', async () => {
  const home = tmp('github-answers-home');
  const hub = fake();
  const check: PrCheck = async (_repo, number) => ({
    merged: false,
    why: null,
    info: { ...prInfo(number) },
  });
  const requested: RequestedCheck = async () => [{ repo: REPO, number: 3092 }];
  const first = new AutoReview(new StoryStore({ home }), check, 1000, hub.check, requested, home);
  first.kickBranch(REPO, BRANCH, '/nowhere', START);
  first.kickInfo(REPO, 3092, START);
  first.kickRequested(START);
  await first.idle();
  const second = new AutoReview(new StoryStore({ home }), check, 1000, hub.check, requested, home);
  assert.equal(second.branchPr(REPO, BRANCH)?.number, 3092);
  assert.equal(second.info(REPO, 3092)?.approvals, 1);
  assert.deepEqual(second.requested(), [{ repo: REPO, number: 3092 }]);
  hub.fail = true;
  second.kickBranch(REPO, BRANCH, '/nowhere', START + 5000);
  await second.idle();
  assert.equal(second.branchPr(REPO, BRANCH)?.number, 3092);
  assert.equal(readGithubAnswers(home).branches[KEY].pr?.number, 3092);
});

test('the newest ask fails: an older ask’s good answer is kept, and no third ask goes out', async () => {
  const releases: ((value: BranchPr | null | 'fail') => void)[] = [];
  const seen: string[][] = [];
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      seen.push(heads);
      const answer = await new Promise<BranchPr | null | 'fail'>((resolve) =>
        releases.push(resolve),
      );
      if (answer === 'fail') {
        throw new Error('gh: HTTP 502');
      }
      return answer;
    },
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START, [HEAD]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [OTHER]);
  assert.deepEqual(seen, [[HEAD], [HEAD, OTHER]]);
  releases[0](MERGED);
  await idle();
  assert.deepEqual(
    review.branchPr(REPO, BRANCH),
    MERGED,
    'the older answer is in while the newer is out',
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 20, [OTHER]);
  assert.equal(seen.length, 2, 'the newer ask still covers both heads');
  releases[1]('fail');
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), MERGED, 'the failed newest keeps it');
  // an older "none" is not kept: it asked fewer heads than the newest
  const none = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      seen.push(heads);
      return new Promise<BranchPr | null>((resolve) =>
        releases.push((value) => resolve(value as null)),
      );
    },
  );
  const before = releases.length;
  none.kickBranch(REPO, BRANCH, '/nowhere', START, [HEAD]);
  none.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [OTHER]);
  releases[before](null);
  await idle();
  assert.equal(none.branchPr(REPO, BRANCH), undefined);
  releases[before + 1](MERGED);
  await none.idle();
  assert.deepEqual(none.branchPr(REPO, BRANCH), MERGED);
  void never;
});

test('an entry stamped in the future (a clock that was ahead) is clamped to now, so it still expires', () => {
  const home = tmp('github-answers-home');
  const future = START + 3600000;
  writeJson(files(home), {
    version: 1,
    branches: { [KEY]: { at: future, pr: OPEN } },
    prs: { [`${REPO.toLowerCase()}#1`]: { at: future, info: prInfo(1) } },
    requested: { at: future, list: [] },
  });
  const read = readGithubAnswers(home, START);
  assert.equal(read.branches[KEY].at, START);
  assert.equal(read.prs[`${REPO.toLowerCase()}#1`].at, START);
  assert.equal(read.requested?.at, START);
  // the bridge writes what it loaded back: a week on from now it is gone
  writeGithubAnswers(home, read, START);
  assert.deepEqual(readGithubAnswers(home, START + KEEP_MS), {
    branches: {},
    prs: {},
    requested: null,
  });
  writeGithubAnswers(
    home,
    { branches: { [KEY]: { at: future, pr: OPEN } }, prs: {}, requested: null },
    START,
  );
  assert.equal(readGithubAnswers(home, START).branches[KEY].at, START, 'a write clamps it too');
});

test('the newest ask fails: an older ask’s merged answer covers only its own heads', async () => {
  const releases: ((value: BranchPr | null | 'fail') => void)[] = [];
  const seen: string[][] = [];
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      seen.push(heads);
      const answer = await new Promise<BranchPr | null | 'fail'>((resolve) =>
        releases.push(resolve),
      );
      if (answer === 'fail') {
        throw new Error('gh: HTTP 502');
      }
      return answer;
    },
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START, [HEAD]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [OTHER]);
  releases[0](MERGED);
  await idle();
  releases[1]('fail');
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), MERGED);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 20, [OTHER]);
  assert.equal(seen.length, 3, 'the answer never covered OTHER, so it is asked again');
});

test('the newest ask fails first: an older ask’s merged answer landing later covers only its own heads', async () => {
  const releases: ((value: BranchPr | null | 'fail') => void)[] = [];
  const seen: string[][] = [];
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    1000,
    async (_repo, _branch, _checkout, heads = []) => {
      seen.push(heads);
      const answer = await new Promise<BranchPr | null | 'fail'>((resolve) =>
        releases.push(resolve),
      );
      if (answer === 'fail') {
        throw new Error('gh: HTTP 502');
      }
      return answer;
    },
  );
  review.kickBranch(REPO, BRANCH, '/nowhere', START, [HEAD]);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 10, [OTHER]);
  releases[1]('fail');
  await idle();
  releases[0](MERGED);
  await review.idle();
  assert.deepEqual(review.branchPr(REPO, BRANCH), MERGED);
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 20, [OTHER]);
  assert.equal(seen.length, 3, 'the answer never covered OTHER, so it is asked again');
});
