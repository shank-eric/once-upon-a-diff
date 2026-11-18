/**
 * What GitHub last said is kept in <home>/github-answers.json, so a bridge that restarts shows the last known state (a
 * story approved with an open PR is in PR open, not Ready to ship) and asks GitHub again at once. Loaded answers are only
 * for display until this run's own answer lands. The real AutoReview and Board run against a fake GitHub, never the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git } from '@once-upon-a-diff/test-kit/git';
import { Board } from '../src/board.ts';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import type {
  BranchCheck,
  BranchPr,
  PrCheck,
  RequestedCheck,
} from '@once-upon-a-diff/state/records/github/github-checks';
import {
  KEEP_MS,
  readGithubAnswers,
  writeGithubAnswers,
} from '@once-upon-a-diff/adapters/stores/github-answers';
import type { BoardCard, PrInfo } from '@once-upon-a-diff/contracts/types';

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
function world(home: string, hub: Fake, { approved = true, check = noPr as PrCheck } = {}) {
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
  const review = new AutoReview(stories, check, 1000, hub.check, requested, home);
  let now = START;
  const board = new Board(home, stories, review, new Builds(home), { now: () => new Date(now) });
  return {
    review,
    /** moves the board's clock on */
    later(millis: number) {
      now += millis;
    },
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
  const reviewed = path.join(home, 'state', 'local-dot-prop', 'review.json');
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
  assert.equal(JSON.parse(readFileSync(reviewed, 'utf8')).mark.by, 'pr');
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
  // the failed ask waits out its backoff (2 s on this 1 s cache) before another goes out
  review.kickBranch(REPO, BRANCH, '/nowhere', START + 2500, [OTHER]);
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

const MIN = 60000;

/** A PR check that counts its asks and answers, or fails with `error` while it is set. */
function prCheck() {
  const state = { asked: 0, error: null as string | null, check: null as unknown as PrCheck };
  state.check = async (_repo, number) => {
    state.asked += 1;
    if (state.error) {
      throw new Error(state.error);
    }
    return { merged: false, why: null, info: prInfo(number) };
  };
  return state;
}

/** The minutes (from START) at which the watcher actually asks, when it is kicked every minute for `until` minutes. */
async function askMinutes(
  until: number,
  kick: (review: AutoReview, now: number) => void,
  state: { asked: number },
  review: AutoReview,
): Promise<number[]> {
  const minutes: number[] = [];
  for (let minute = 0; minute <= until; minute++) {
    const before = state.asked;
    kick(review, START + minute * MIN);
    await review.idle();
    if (state.asked > before) {
      minutes.push(minute);
    }
  }
  return minutes;
}

test('an answer keeps its age across a restart, a failed ask, a ping and a later answer', async () => {
  const home = tmp('github-answers-home');
  const hub = fake();
  const prs = prCheck();
  const first = new AutoReview(
    new StoryStore({ home }),
    prs.check,
    1000,
    hub.check,
    async () => [],
    home,
  );
  assert.equal(first.infoAt(REPO, 3092), null, 'never answered');
  assert.equal(first.branchAt(REPO, BRANCH), null);
  first.kickInfo(REPO, 3092, START);
  first.kickBranch(REPO, BRANCH, '/nowhere', START);
  await first.idle();
  assert.equal(first.infoAt(REPO, 3092), START);
  assert.equal(first.branchAt(REPO, BRANCH), START);
  // a restart: the answer's own age, not "never" and not "now"
  const slow = fake();
  slow.hold = never() as Promise<void>;
  const second = new AutoReview(
    new StoryStore({ home }),
    prs.check,
    1000,
    slow.check,
    async () => [],
    home,
  );
  assert.equal(second.infoAt(REPO, 3092), START);
  assert.equal(second.branchAt(REPO, BRANCH), START);
  // an ask in flight and a ping do not move it
  second.kickBranch(REPO, BRANCH, '/nowhere', START + 9000);
  assert.equal(second.branchAt(REPO, BRANCH), START);
  second.refresh({ repo: REPO, branch: BRANCH }, START + 10000);
  assert.equal(second.branchAt(REPO, BRANCH), START);
  // a failed ask keeps it
  const third = new AutoReview(
    new StoryStore({ home }),
    prs.check,
    1000,
    hub.check,
    async () => [],
    home,
  );
  hub.fail = true;
  prs.error = 'gh: HTTP 502';
  third.kickBranch(REPO, BRANCH, '/nowhere', START + 20000);
  third.kickInfo(REPO, 3092, START + 20000);
  await third.idle();
  assert.equal(third.infoAt(REPO, 3092), START);
  assert.equal(third.branchAt(REPO, BRANCH), START);
  // a later answer moves it
  hub.fail = false;
  prs.error = null;
  third.kickBranch(REPO, BRANCH, '/nowhere', START + 10 * MIN);
  third.kickInfo(REPO, 3092, START + 10 * MIN);
  await third.idle();
  assert.equal(third.infoAt(REPO, 3092), START + 10 * MIN);
  assert.equal(third.branchAt(REPO, BRANCH), START + 10 * MIN);
});

test('a PR that keeps failing is asked again after 6, then 12, then 24 minutes, not every 3', async () => {
  const prs = prCheck();
  prs.error = 'gh: HTTP 502';
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    prs.check,
    3 * MIN,
  );
  const minutes = await askMinutes(70, (one, now) => one.kickInfo(REPO, 3092, now), prs, review);
  assert.deepEqual(
    minutes,
    [0, 6, 18, 42, 72].filter((minute) => minute <= 70),
  );
  assert.equal(review.infoAt(REPO, 3092), null);
});

test('a PR GitHub says does not exist is asked once, until a ping names it', async () => {
  const prs = prCheck();
  prs.error =
    'gh: Could not resolve to a PullRequest with the number of 3092. (repository.pullRequest)';
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    prs.check,
    3 * MIN,
  );
  const minutes = await askMinutes(60, (one, now) => one.kickInfo(REPO, 3092, now), prs, review);
  assert.deepEqual(minutes, [0]);
  review.refresh({ repo: REPO, number: 3092 }, START + 61 * MIN);
  review.kickInfo(REPO, 3092, START + 61 * MIN);
  await review.idle();
  assert.equal(prs.asked, 2, 'a ping about it asks again');
});

test('a success after failures puts the gap back to the cache time', async () => {
  const prs = prCheck();
  prs.error = 'gh: HTTP 502';
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    prs.check,
    3 * MIN,
  );
  const kick = (minute: number) => review.kickInfo(REPO, 3092, START + minute * MIN);
  kick(0);
  await review.idle();
  prs.error = null;
  kick(5);
  await review.idle();
  assert.equal(prs.asked, 1, 'still inside the 6 minutes');
  kick(6);
  await review.idle();
  assert.equal(prs.asked, 2);
  kick(8);
  await review.idle();
  assert.equal(prs.asked, 2);
  kick(9);
  await review.idle();
  assert.equal(prs.asked, 3, 'back to the 3 minute window');
});

test('a branch that keeps failing backs off the same way, and a missing repo is asked once', async () => {
  const hub = fake();
  hub.fail = true;
  const review = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    3 * MIN,
    hub.check,
  );
  const kick = (one: AutoReview, now: number) => one.kickBranch(REPO, BRANCH, '/nowhere', now);
  assert.deepEqual(await askMinutes(30, kick, hub, review), [0, 6, 18]);
  const gone = fake();
  gone.check = async () => {
    gone.asked += 1;
    throw new Error('gh: Could not resolve to a Repository with the name Acme/Widgets.');
  };
  const other = new AutoReview(
    new StoryStore({ home: tmp('github-answers-home') }),
    noPr,
    3 * MIN,
    gone.check,
  );
  assert.deepEqual(await askMinutes(60, kick, gone, other), [0]);
  other.refresh({ repo: REPO, branch: BRANCH }, START + 61 * MIN);
  kick(other, START + 61 * MIN);
  await other.idle();
  assert.equal(gone.asked, 2);
});

test('a PR card says unconfirmed until GitHub answers about it, and again once the answer is 15 minutes old', async () => {
  const home = tmp('github-answers-home');
  const hub = fake();
  const prs = prCheck();
  prs.error = 'gh: HTTP 502';
  const sim = world(home, hub, { check: prs.check });
  await sim.cards();
  await sim.review.idle();
  const stub = (await sim.cards())[0];
  assert.equal(stub.pr?.number, 3092);
  assert.equal(stub.pr_unconfirmed, true, 'a stub PR: GitHub never answered');
  assert.equal(stub.column, 'pr_open');
  // it answers: not flagged
  prs.error = null;
  sim.later(10 * MIN);
  await sim.cards();
  await sim.review.idle();
  assert.equal((await sim.cards())[0].pr_unconfirmed, undefined);
  // 14 minutes on, asks keep failing: still inside the window
  prs.error = 'gh: HTTP 502';
  sim.later(14 * MIN);
  await sim.cards();
  await sim.review.idle();
  assert.equal((await sim.cards())[0].pr_unconfirmed, undefined);
  // past 15 minutes since the answer: flagged
  sim.later(2 * MIN);
  assert.equal((await sim.cards())[0].pr_unconfirmed, true);
  // an answer clears it
  prs.error = null;
  sim.later(30 * MIN);
  await sim.cards();
  await sim.review.idle();
  assert.equal((await sim.cards())[0].pr_unconfirmed, undefined);
});

test('a loaded answer is judged by its own age', async () => {
  const home = tmp('github-answers-home');
  const old = START - 20 * MIN;
  writeGithubAnswers(home, {
    branches: { [KEY]: { at: old, pr: OPEN } },
    prs: { [`${REPO.toLowerCase()}#3092`]: { at: old, info: prInfo() } },
    requested: null,
  });
  const prs = prCheck();
  prs.error = 'gh: HTTP 502';
  const sim = world(home, fake(), { check: prs.check });
  const [card] = await sim.cards();
  assert.equal(card.pr?.title, 'PR 3092', 'the loaded answer is shown');
  assert.equal(card.pr_unconfirmed, true, 'twenty minutes old, and nothing newer');
  prs.error = null;
  sim.later(10 * MIN);
  await sim.cards();
  await sim.review.idle();
  assert.equal((await sim.cards())[0].pr_unconfirmed, undefined);
});
