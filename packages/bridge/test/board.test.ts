import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, localRepo, tmp, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import {
  ghBranchCheck,
  ghPrCheck,
  ghRequestedCheck,
  mergeSummary,
} from '../src/review-inbox/auto-review.ts';
import { inboxKey } from '../src/server/page-key.ts';
import type { InboxList } from '@once-upon-a-diff/shared/types';

const NOW = new Date('2026-10-26T19:00:00Z'); // 3:00 PM EDT

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

function prStory(
  home: string,
  id: string,
  repo: string,
  number: number,
  branch: string | null = null,
  state: Record<string, unknown> = {},
) {
  const dir = path.join(home, id);
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo,
    number,
    pr_title: `PR ${number}`,
    ...(branch ? { head_ref: branch } : {}),
  });
  writeJson(path.join(dir, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

test('the review inbox lists built PR stories, and Mark reviewed works on them', async () => {
  const home = tmp('board-inbox');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  prStory(home, 'acme-gadgets-3', 'acme/gadgets', 3);
  writeJson(path.join(home, 'local-x', 'meta.json'), {
    kind: 'local',
    repo_path: '/x',
    base: 'a',
    head: 'b',
  });
  writeJson(path.join(home, 'local-x', 'chapters.json'), { title: 'Local', chapters: [] });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const asInbox = (method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${inboxKey(TOKEN)}` });

  const list = (await asInbox('GET', '/api/inbox')).body as InboxList;
  const link = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}/files`;
  assert.deepEqual(
    list.stories
      .map((story) => [
        story.id,
        story.repo,
        story.number,
        story.title,
        story.url,
        story.reviewed_at,
      ])
      .sort(),
    [
      ['acme-gadgets-3', 'acme/gadgets', 3, 'Story 3', link('acme/gadgets', 3), null],
      ['acme-widgets-7', 'acme/widgets', 7, 'Story 7', link('acme/widgets', 7), null],
    ],
    'a local story is not a PR story',
  );
  assert.deepEqual(list.repos.map((repo) => [repo.repo, repo.unreviewed]).sort(), [
    ['acme/gadgets', 1],
    ['acme/widgets', 1],
  ]);
  const filtered = (await asInbox('GET', '/api/inbox?repo=acme/widgets')).body as InboxList;
  assert.deepEqual(
    filtered.stories.map((story) => story.id),
    ['acme-widgets-7'],
  );

  const marked = await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-7' });
  assert.equal(marked.status, 200);
  assert.ok((marked.body as { story: { reviewed_at: string } }).story.reviewed_at);
  const after = (await asInbox('GET', '/api/inbox')).body as InboxList;
  assert.equal(after.repos.find((repo) => repo.repo === 'acme/widgets')?.unreviewed, 0);
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-7', reviewed: false });
  const undone = (await asInbox('GET', '/api/inbox')).body as InboxList;
  assert.equal(undone.stories.find((story) => story.id === 'acme-widgets-7')?.reviewed_at, null);
  for (const id of ['local-x', 'nope', '../x']) {
    assert.equal((await asInbox('POST', '/api/inbox/reviewed', { story: id })).status, 404, id);
  }
});

// ---------- the inbox marks a PR story reviewed when GitHub says you have

/** The PR as GitHub's GraphQL answers it: who reviewed (each with an approval at REVIEWED_AT), and each file's Viewed state. */
const REVIEWED_AT = '2026-10-26T12:00:00Z';
const prAnswer = (
  reviewers: string[],
  states: string[],
  merged = false,
  {
    state = 'OPEN',
    headRef = { id: 'ref1' } as { id: string } | null,
    reviews = reviewers.map((login) => ({
      state: 'APPROVED',
      body: '',
      submittedAt: REVIEWED_AT,
      author: { login },
    })) as unknown[],
  } = {},
) => ({
  data: {
    viewer: { login: 'octocat' },
    repository: {
      pullRequest: {
        merged,
        state,
        headRef,
        reviews: { nodes: reviews },
        files: {
          totalCount: states.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: states.map((viewerViewedState) => ({ viewerViewedState })),
        },
      },
    },
  },
});

test('the PR check reads your review and your Viewed marks through gh', async () => {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-check'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  try {
    const withoutInfo = async (repo: string, number: number) => {
      const { info: _info, ...rest } = await ghPrCheck(repo, number);
      return rest;
    };
    const answers: [string[], string[], string | null, boolean][] = [
      [['someone'], ['VIEWED', 'UNVIEWED'], null, false],
      [['someone', 'OctoCat'], ['UNVIEWED'], 'review', false],
      [[], ['VIEWED', 'VIEWED'], 'all viewed', true],
      [[], ['VIEWED', 'DISMISSED'], null, false],
      [[], [], null, false],
      // a review and every file Viewed: the check says both, and the story's build time picks
      [['octocat'], ['VIEWED'], 'review', true],
    ];
    for (const [reviewers, states, expected, viewed] of answers) {
      writeJson(json, prAnswer(reviewers, states));
      assert.deepEqual(
        await withoutInfo('acme/widgets', 7),
        {
          merged: false,
          why: expected,
          reviewed_at: expected === 'review' ? REVIEWED_AT : null,
          viewed,
        },
        JSON.stringify(states),
      );
    }
    // a COMMENTED review with no body is a reply in a thread, which isn't a review; one with a body is
    const review = (state: string, body: string, submittedAt: string, login = 'OctoCat') => ({
      state,
      body,
      submittedAt,
      author: { login },
    });
    const reviewedAt = async (reviews: unknown[]) => {
      writeJson(json, prAnswer([], ['UNVIEWED'], false, { reviews }));
      return (await ghPrCheck('acme/widgets', 7)).reviewed_at;
    };
    assert.equal(await reviewedAt([review('COMMENTED', '', '2026-10-26T13:00:00Z')]), null);
    assert.equal(await reviewedAt([review('COMMENTED', '  \n', '2026-10-26T13:00:00Z')]), null);
    assert.equal(
      await reviewedAt([
        review('APPROVED', '', '2026-10-26T10:00:00Z'),
        review('COMMENTED', '', '2026-10-26T13:00:00Z'),
        review('COMMENTED', 'one nit', '2026-10-26T11:00:00Z'),
        review('CHANGES_REQUESTED', 'no', '2026-10-26T15:00:00Z', 'someone'),
      ]),
      '2026-10-26T11:00:00Z',
      'the latest review of yours that counts',
    );
    writeJson(json, prAnswer(['octocat'], ['VIEWED'], true));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), { merged: true, why: null });
    // closed: the branch decides (a deleted fork's branch is gone too)
    writeJson(json, prAnswer([], [], false, { state: 'CLOSED' }));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), {
      merged: false,
      why: null,
      reviewed_at: null,
      viewed: false,
    });
    writeJson(json, prAnswer([], [], false, { state: 'CLOSED', headRef: null }));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), {
      merged: false,
      abandoned: true,
      why: null,
    });
    writeJson(json, prAnswer([], [], false, { headRef: null }));
    assert.deepEqual(
      await withoutInfo('acme/widgets', 7),
      { merged: false, why: null, reviewed_at: null, viewed: false },
      'open stays',
    );
    writeJson(json, { errors: [{ message: 'Could not resolve' }] });
    await assert.rejects(ghPrCheck('acme/widgets', 7), /Could not resolve/);
  } finally {
    for (const [key, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('a PR story you reviewed or finished Viewing is marked in the inbox, with why; a manual unmark sticks', async () => {
  const home = tmp('board-auto');
  for (const [id, number] of [
    ['acme-widgets-1', 1],
    ['acme-widgets-2', 2],
    ['acme-widgets-3', 3],
    ['acme-widgets-4', 4],
  ] as const) {
    prStory(home, id, 'acme/widgets', number);
  }
  const asked: number[] = [];
  const why: Record<number, 'review' | 'all viewed' | null> = {
    1: 'review',
    2: 'all viewed',
    3: null,
    4: 'review',
  };
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => {
      asked.push(number);
      return { merged: false, why: why[number] };
    },
  });
  open.push(bridge);
  const asInbox = (method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const stories = async () =>
    Object.fromEntries(
      ((await asInbox('GET', '/api/inbox')).body as InboxList).stories.map((story) => [
        story.number,
        [!!story.reviewed_at, story.reviewed_by],
      ]),
    );

  // 4 is unmarked by hand before GitHub is asked: that decision stays
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-4', reviewed: false });
  assert.deepEqual((await stories())[1], [false, null], 'the poll answers before GitHub does');
  await bridge.server.autoReview.idle();
  assert.deepEqual(await stories(), {
    1: [true, 'review'],
    2: [true, 'all viewed'],
    3: [false, null],
    4: [false, null],
  });
  assert.deepEqual(asked.sort(), [1, 2, 3, 4], 'every listed PR is asked about once');

  // polls inside the cache window don't ask again
  await stories();
  await bridge.server.autoReview.idle();
  assert.equal(asked.length, 4);

  // a manual unmark of an auto-marked story sticks, and a manual mark says so
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-1', reviewed: false });
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-3' });
  await stories();
  await bridge.server.autoReview.idle();
  assert.deepEqual(await stories(), {
    1: [false, null],
    2: [true, 'all viewed'],
    3: [true, 'manual'],
    4: [false, null],
  });
});

test('a PR story whose PR has merged, or closed with its branch deleted, leaves the inbox and the board count; a closed one with its branch stays', async () => {
  const home = tmp('board-merged');
  for (const number of [1, 2, 3, 4]) {
    prStory(home, `acme-widgets-${number}`, 'acme/widgets', number);
  }
  writeJson(path.join(home, 'state', 'acme-widgets-2', 'reviewed.json'), {
    at: NOW.toISOString(),
    by: 'manual',
  });
  const merged = new Set([1, 2]);
  const bridge = await startBridge({
    home,
    // 3 is closed with its branch still there, 4 closed with the branch deleted
    checkPr: async (_repo, number) => ({
      merged: merged.has(number),
      abandoned: number === 4,
      why: null,
    }),
  });
  open.push(bridge);
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const ids = async () => {
    const list = (await asInbox('GET', '/api/inbox')).body as InboxList;
    return [list.stories.map((story) => story.id).sort(), list.repos[0]?.unreviewed];
  };
  assert.deepEqual(await ids(), [
    ['acme-widgets-1', 'acme-widgets-2', 'acme-widgets-3', 'acme-widgets-4'],
    3,
  ]);
  await bridge.server.autoReview.idle();
  assert.deepEqual(await ids(), [['acme-widgets-3'], 1]);
});

/** Runs `body` with gh faked: its answer is `answer.json` in `dir`, and each call's arguments go to `calls.log`. */
async function withFakeGh(
  dir: string,
  body: (io: { answer: string; calls: () => string[][] }) => Promise<void>,
) {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const answer = path.join(dir, 'answer.json');
  const log = path.join(dir, 'calls.log');
  const names = ['ONCE_UPON_GH', 'FAKE_GH_PR_JSON', 'FAKE_GH_LOG'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = answer;
  process.env.FAKE_GH_LOG = log;
  try {
    await body({
      answer,
      calls: () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [],
    });
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[index];
      }
    });
  }
}

test('a story is marked reviewed only by a review you submitted after it was built', async () => {
  const home = tmp('board-built');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  // 1: reviewed before the story was built, 2: after (stories are built now)
  const facts = new Map<number, { reviewed_at: string | null; viewed: boolean }>([
    [1, { reviewed_at: '2020-01-01T00:00:00Z', viewed: false }],
    [2, { reviewed_at: '2099-01-01T00:00:00Z', viewed: false }],
  ]);
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => ({
      merged: false,
      why: 'review',
      ...facts.get(number),
    }),
  });
  open.push(bridge);
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const list = async () => (await asInbox('GET', '/api/inbox')).body as InboxList;
  const marks = async () => {
    await asInbox('GET', '/api/inbox');
    await bridge.server.autoReview.idle();
    return Object.fromEntries(
      (await list()).stories.map((story) => [story.number, story.reviewed_by]),
    );
  };
  assert.deepEqual(await marks(), { 1: null, 2: 'review' });
});

test('an older review does not stop every file Viewed from marking the story, and no review at all marks nothing', async () => {
  const home = tmp('board-built-viewed');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => ({
      merged: false,
      why: 'review',
      reviewed_at: number === 1 ? '2020-01-01T00:00:00Z' : null,
      viewed: number === 1,
    }),
  });
  open.push(bridge);
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  await asInbox('GET', '/api/inbox');
  await bridge.server.autoReview.idle();
  const stories = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
  assert.deepEqual(Object.fromEntries(stories.map((story) => [story.number, story.reviewed_by])), {
    1: 'all viewed',
    2: null,
  });
});

test('the board and the inbox share one check per PR, in either order, and the answer reaches every story of the PR', async () => {
  const home = tmp('board-shared');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-1-again', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  const asked: number[] = [];
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => {
      asked.push(number);
      return {
        merged: number === 2,
        why: 'review',
        info: { number, state: number === 2 ? 'merged' : 'open' } as never,
      };
    },
  });
  open.push(bridge);
  const review = bridge.server.autoReview;
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const marks = async () => {
    const stories = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
    await review.idle();
    return stories.length;
  };

  // the board asks about 1 and 2 first: the inbox poll in the same window neither asks again nor loses the answer
  review.kickInfo('acme/widgets', 1);
  review.kickInfo('acme/widgets', 2);
  assert.equal(await marks(), 3);
  assert.deepEqual(asked.sort(), [1, 2], 'one check per PR');
  const after = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
  assert.deepEqual(
    after.map((story) => [story.id, story.reviewed_by]).sort(),
    [
      ['acme-widgets-1', 'review'],
      ['acme-widgets-1-again', 'review'],
    ],
    'both stories of PR 1 are marked and the merged PR 2 is dropped, from the board’s check',
  );
  assert.equal(review.info('acme/widgets', 1)?.number, 1);
  assert.equal(review.info('acme/widgets', 2)?.state, 'merged');

  // the inbox first, then the board in the same window
  const second = tmp('board-shared-2');
  prStory(second, 'acme-widgets-5', 'acme/widgets', 5);
  const asked5: number[] = [];
  const other = await startBridge({
    home: second,
    checkPr: async (_repo, number) => {
      asked5.push(number);
      return { merged: false, why: null, info: { number } as never };
    },
  });
  open.push(other);
  await other.call('GET', '/api/inbox', undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  other.server.autoReview.kickInfo('acme/widgets', 5);
  await other.server.autoReview.idle();
  assert.deepEqual(asked5, [5]);
  assert.equal(other.server.autoReview.info('acme/widgets', 5)?.number, 5);
});

test('the branch check keeps PRs from this repo, prefers an open one, and counts a merged one only when the local branch contains its head', async () => {
  const { repo: checkout } = localRepo(); // branch "feature": base, change one, add two
  const [tip, behind] = git(checkout, 'rev-list', '--max-count=2', 'HEAD').split('\n');
  git(checkout, 'switch', '-q', '-c', 'elsewhere', 'HEAD~2');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'not on feature');
  const stray = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'switch', '-q', 'feature');
  const node = (
    number: number,
    oid: string,
    nameWithOwner: string | null,
    mergedAt: string | null = null,
  ) => ({
    number,
    mergedAt,
    headRefOid: oid,
    headRepository: nameWithOwner ? { nameWithOwner } : null,
  });
  await withFakeGh(tmp('branch-check'), async ({ answer, calls }) => {
    const ask = async (opened: unknown[], merged: unknown[]) => {
      writeJson(answer, {
        data: { repository: { open: { nodes: opened }, merged: { nodes: merged } } },
      });
      return ghBranchCheck('Acme/Widgets', 'feature', checkout);
    };
    const mine = 'acme/widgets';
    assert.deepEqual(
      await ask([node(5, tip, mine)], [node(3, behind, mine, '2026-10-01T00:00:00Z')]),
      {
        number: 5,
        state: 'open',
        merged_at: null,
      },
    );
    // a PR from a fork with the same branch name is not this checkout's
    assert.deepEqual(
      await ask(
        [node(6, tip, 'fork/widgets'), node(7, tip, null)],
        [node(3, behind, mine, '2026-10-01T00:00:00Z')],
      ),
      { number: 3, state: 'merged', merged_at: '2026-10-01T00:00:00Z' },
    );
    assert.equal(await ask([], [node(3, behind, 'fork/widgets', '2026-10-01T00:00:00Z')]), null);
    // merged: its head is the tip, or behind it: the latest such one; a head the branch doesn't have is an old PR of a reused name
    assert.deepEqual(
      await ask(
        [],
        [
          node(2, behind, mine, '2026-10-01T00:00:00Z'),
          node(4, tip, mine, '2026-10-03T00:00:00Z'),
          node(9, stray, mine, '2026-10-09T00:00:00Z'),
        ],
      ),
      { number: 4, state: 'merged', merged_at: '2026-10-03T00:00:00Z' },
    );
    assert.equal(await ask([], [node(9, stray, mine, '2026-10-09T00:00:00Z')]), null);
    assert.equal(
      await ask([], [node(9, '0'.repeat(40), mine, '2026-10-09T00:00:00Z')]),
      null,
      'a head commit this checkout has never seen',
    );
    // open and merged are asked for separately, up to 100 each, with the head repository and commit
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /open:pullRequests\(headRefName:\$branch,first:100,states:\[OPEN\]/);
    assert.match(query, /merged:pullRequests\(headRefName:\$branch,first:100,states:\[MERGED\]/);
    assert.match(query, /headRefOid headRepository\{nameWithOwner\}/);
  });
});

test('the review-requested search and PrInfo.review_requested both count only requests made of you by name', async () => {
  await withFakeGh(tmp('requested'), async ({ answer, calls }) => {
    writeJson(answer, {
      data: {
        search: {
          nodes: [{ number: 4, repository: { nameWithOwner: 'acme/widgets' } }, {}],
        },
      },
    });
    assert.deepEqual(await ghRequestedCheck(), [{ repo: 'acme/widgets', number: 4 }]);
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /user-review-requested:@me/);
    assert.doesNotMatch(query.replace('user-review-requested:@me', ''), /review-requested:@me/);

    // a request to a team reads as no User login, so it is not yours
    const pr = prAnswer([], ['UNVIEWED']);
    const node = pr.data.repository.pullRequest as Record<string, unknown>;
    node.reviewRequests = {
      nodes: [{ requestedReviewer: {} }, { requestedReviewer: { login: 'someone' } }],
    };
    writeJson(answer, pr);
    assert.equal((await ghPrCheck('acme/widgets', 7)).info?.review_requested, false);
    const asked = calls()
      .at(-1)
      ?.find((arg) => arg.startsWith('query=')) as string;
    assert.match(
      asked,
      /reviewRequests\(first:30\)\{nodes\{requestedReviewer\{\.\.\. on User\{login\}\}\}\}/,
    );
    node.reviewRequests = { nodes: [{ requestedReviewer: { login: 'OctoCat' } }] };
    writeJson(answer, pr);
    assert.equal((await ghPrCheck('acme/widgets', 7)).info?.review_requested, true);
  });
});

test('the PR check reads what the board shows: approvals, checks, mergeable, and who commented after whom', async () => {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-info'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  const rules = path.join(path.dirname(json), 'rules.json');
  writeJson(rules, [
    { type: 'deletion' },
    { type: 'pull_request', parameters: { required_approving_review_count: 3 } },
  ]);
  process.env.FAKE_GH_RULES_JSON = rules;
  try {
    const person = (login: string, type = 'User') => ({ login, __typename: type });
    writeJson(json, {
      data: {
        viewer: { login: 'Octocat' },
        repository: {
          pullRequest: {
            number: 7,
            url: 'https://github.com/acme/widgets/pull/7',
            title: 'Seven',
            merged: false,
            mergedAt: null,
            state: 'OPEN',
            isDraft: true,
            headRefName: 'feat/seven',
            headRef: { id: 'ref1' },
            author: { login: 'OctoCat' },
            reviewRequests: {
              nodes: [{ requestedReviewer: { login: 'OCTOCAT' } }, { requestedReviewer: {} }],
            },
            mergeStateStatus: 'BLOCKED',
            baseRefName: 'rules-base',
            reviewDecision: 'REVIEW_REQUIRED',
            baseRef: { branchProtectionRule: null, refUpdateRule: null },
            latestOpinionatedReviews: {
              nodes: [
                { state: 'APPROVED', author: { login: 'one' } },
                { state: 'COMMENTED', author: { login: 'two' } },
              ],
            },
            reviews: {
              nodes: [
                { state: 'COMMENTED', submittedAt: '2026-10-26T10:00:00Z', author: person('two') },
                {
                  state: 'COMMENTED',
                  body: 'A note on the approach',
                  submittedAt: '2026-10-26T12:00:00Z',
                  author: person('octocat'),
                },
              ],
            },
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  comments: {
                    nodes: [
                      { createdAt: '2026-10-26T13:00:00Z', author: person('two') },
                      { createdAt: '2026-10-26T14:00:00Z', author: person('one') },
                    ],
                  },
                },
                { isResolved: true, comments: { nodes: [] } },
              ],
            },
            comments: {
              nodes: [
                { createdAt: '2026-10-26T16:00:00Z', author: person('snyk', 'Bot') },
                { createdAt: '2026-10-26T11:00:00Z', author: person('OCTOCAT') },
              ],
            },
            commits: {
              nodes: [
                {
                  commit: {
                    committedDate: '2026-10-26T09:00:00Z',
                    author: { user: { login: 'someone' } },
                    statusCheckRollup: { state: 'FAILURE' },
                  },
                },
              ],
            },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    // you reviewed, so the story counts as reviewed too (why: review), and the details come with it
    const { info, why } = await ghPrCheck('acme/widgets', 7);
    assert.equal(why, 'review');
    assert.deepEqual(info, {
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Seven',
      state: 'open',
      draft: true,
      branch: 'feat/seven',
      author: 'OctoCat',
      mine: true,
      review_requested: true,
      approvals: 1,
      required: 3, // from the base branch's ruleset, since protection says nothing
      review: 'review_required',
      checks: 'failure',
      merge: { ready: false, text: 'needs 2 more approvals', tone: 'warn' },
      merged_at: null,
      unresolved: 1,
      viewer_at: '2026-10-26T12:00:00.000Z'.replace('.000', ''),
      others_at: '2026-10-26T14:00:00Z',
    });
  } finally {
    for (const [name, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
      ['FAKE_GH_RULES_JSON', undefined],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('what blocks the merge button, in one plain line', () => {
  const base = { approvals: 0, required: null, review: null, checks: null, unresolved: 0 } as const;
  const say = (status: string, extra: Partial<Parameters<typeof mergeSummary>[0]> = {}) =>
    mergeSummary({ ...base, status, ...extra })?.text;
  assert.equal(say('CLEAN'), 'ready to merge');
  assert.equal(say('HAS_HOOKS'), 'ready to merge');
  assert.equal(say('UNSTABLE'), 'ready to merge (optional checks failing)');
  assert.equal(mergeSummary({ ...base, status: 'UNSTABLE' })?.ready, true);
  assert.equal(say('DRAFT'), 'draft');
  assert.equal(say('DIRTY'), 'conflicts');
  assert.equal(say('BEHIND'), 'behind base');
  assert.equal(say('BLOCKED', { approvals: 1, required: 2 }), 'needs 1 more approval');
  assert.equal(say('BLOCKED', { approvals: 1, required: 3 }), 'needs 2 more approvals');
  assert.equal(
    say('BLOCKED', { approvals: 2, required: 2, review: 'changes_requested' }),
    'changes requested',
  );
  assert.equal(say('BLOCKED', { approvals: 2, required: 2, checks: 'failure' }), 'checks failing');
  assert.equal(say('BLOCKED', { approvals: 2, required: 2, checks: 'pending' }), 'checks running');
  assert.equal(
    say('BLOCKED', { approvals: 2, required: 2, unresolved: 2 }),
    'open threads to resolve',
  );
  assert.equal(
    say('BLOCKED', { approvals: 0, required: null, review: 'review_required' }),
    'needs approval',
  );
  assert.equal(mergeSummary({ ...base, status: 'BLOCKED' })?.ready, false);
  assert.equal(mergeSummary({ ...base, status: 'UNKNOWN' }), null);
  assert.equal(mergeSummary({ ...base, status: undefined }), null);
});

type Who = { login: string; __typename?: string };
const user = (login: string): Who => ({ login, __typename: 'User' });
const comment = (when: string, author: Who, body = 'text') => ({ createdAt: when, author, body });
const thread = (resolved: boolean, comments: ReturnType<typeof comment>[]) => ({
  isResolved: resolved,
  opener: { nodes: comments.slice(0, 1) },
  comments: { nodes: comments.slice(-5) },
});

interface AskParts {
  /** who opened the PR (default octocat, the viewer: their own PR) */
  author?: string;
  reviews?: { state: string; submittedAt: string; author: Who }[];
  standing?: { state: string; author: { login: string } }[];
  threads?: ReturnType<typeof thread>[];
  issue?: ReturnType<typeof comment>[];
}

/**
 * Runs `body` with gh replaced by a fake that answers the PR query with what `ask` is given, as `octocat`. `ask` returns
 * the PR's others_at: when someone last asked something of the viewer.
 */
async function withFakePr(
  body: (ask: (parts: AskParts) => Promise<string | null | undefined>) => Promise<void>,
) {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-action'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  const ask = async (parts: AskParts) => {
    writeJson(json, {
      data: {
        viewer: { login: 'octocat' },
        repository: {
          pullRequest: {
            author: { login: parts.author ?? 'octocat' },
            merged: false,
            state: 'OPEN',
            headRef: { id: 'ref1' },
            latestOpinionatedReviews: { nodes: parts.standing || [] },
            reviews: { nodes: parts.reviews || [] },
            reviewThreads: { nodes: parts.threads || [] },
            comments: { nodes: parts.issue || [] },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    return (await ghPrCheck('acme/widgets', 7)).info?.others_at;
  };
  try {
    await body(ask);
  } finally {
    for (const [name, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('Back to you on your own PR needs something asked of you: changes requested or an open thread, not bots or AI-review comments', async () =>
  withFakePr(async (ask) => {
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    // #6970's case: only issue comments by scanners and the AI review, nothing asked of you
    assert.equal(
      await ask({
        issue: [
          comment('2026-10-26T17:10:00Z', user('snyk-io')),
          comment('2026-10-26T17:19:00Z', { login: 'cypress', __typename: 'Bot' }),
          comment('2026-10-26T17:28:00Z', user('blafev'), marker),
        ],
      }),
      null,
    );
    // a COMMENTED review asks nothing; a standing changes-requested one does
    const review = (state: string, when: string, login = 'other') => ({
      state,
      submittedAt: when,
      author: user(login),
    });
    assert.equal(await ask({ reviews: [review('COMMENTED', '2026-10-26T18:00:00Z')] }), null);
    assert.equal(
      await ask({
        reviews: [review('CHANGES_REQUESTED', '2026-10-26T18:00:00Z')],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'other' } }],
      }),
      '2026-10-26T18:00:00Z',
    );
    assert.equal(
      await ask({
        reviews: [review('CHANGES_REQUESTED', '2026-10-26T18:00:00Z')],
        standing: [{ state: 'APPROVED', author: { login: 'other' } }],
      }),
      null,
      'they approved afterwards',
    );
    // open threads: the newest comment that counts decides, and it has to be a person's
    const them = user('other');
    const open = (comments: ReturnType<typeof comment>[], resolved = false) =>
      ask({ threads: [thread(resolved, comments)] });
    assert.equal(await open([comment('2026-10-26T13:00:00Z', them)]), '2026-10-26T13:00:00Z');
    assert.equal(await open([comment('2026-10-26T13:00:00Z', them)], true), null, 'resolved');
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T14:00:00Z', user('Octocat')),
      ]),
      null,
      'you answered last',
    );
    assert.equal(await open([comment('2026-10-26T13:00:00Z', user('github-actions'))]), null);
    assert.equal(await open([comment('2026-10-26T13:00:00Z', user('someone[bot]'))]), null);
    // the AI review counts only when its comment opened the thread
    assert.equal(
      await open([comment('2026-10-26T13:00:00Z', them, marker)]),
      '2026-10-26T13:00:00Z',
    );
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', user('Octocat')),
        comment('2026-10-26T14:00:00Z', them, marker),
      ]),
      null,
      'a marked reply does not open anything',
    );
    // a bot's or the AI review's reply after a person's request doesn't hide it
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T13:05:00Z', user('github-actions')),
        comment('2026-10-26T13:06:00Z', user('blafev'), marker),
        comment('2026-10-26T13:07:00Z', { login: 'coderabbit', __typename: 'Bot' }),
      ]),
      '2026-10-26T13:00:00Z',
    );
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T13:30:00Z', user('Octocat')),
        comment('2026-10-26T13:35:00Z', user('github-actions')),
      ]),
      null,
      'you answered, and only a bot spoke after',
    );
  }));

test('on someone else’s PR, Back to you is only an answer in a thread you are in: new third-party threads and others’ changes requested stay PR open', () =>
  withFakePr(async (ask) => {
    const them = user('luis');
    const bot = user('blafev'); // the AI review posts under a person's account
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    const theirs = { author: 'luis' };
    // #6980's shape: Luis's PR, your two threads unanswered, and four new threads from the AI review aimed at the author
    const yours = [
      thread(false, [
        comment('2026-10-26T10:00:00Z', user('Octocat')),
        comment('2026-10-26T10:05:00Z', them),
      ]),
    ];
    const ours = thread(false, [comment('2026-10-26T10:00:00Z', user('octocat'))]);
    const newOnes = [1, 2, 3, 4].map((minute) =>
      thread(false, [comment(`2026-10-26T12:0${minute}:00Z`, bot, marker)]),
    );
    // your thread's last comment is the author's reply: that is an answer to you
    assert.equal(await ask({ ...theirs, threads: yours }), '2026-10-26T10:05:00Z');
    // your threads have nobody's answer, and four new threads aren't yours: nothing is asked of you
    assert.equal(await ask({ ...theirs, threads: [ours, ours, ...newOnes] }), null);
    // a new thread by a person you aren't in, and a reviewer's changes requested, are for the author
    assert.equal(
      await ask({
        ...theirs,
        threads: [ours, thread(false, [comment('2026-10-26T13:00:00Z', user('bobby'))])],
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-26T13:10:00Z',
            author: user('bobby'),
          },
        ],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'bobby' } }],
      }),
      null,
    );
    // a reply in a thread you started counts, from the author or from another reviewer, once a person has the last word
    const answered = thread(false, [
      comment('2026-10-26T10:00:00Z', user('octocat')),
      comment('2026-10-26T14:00:00Z', user('bobby')),
      comment('2026-10-26T14:05:00Z', { login: 'github-actions', __typename: 'Bot' }),
      comment('2026-10-26T14:06:00Z', bot, marker),
    ]);
    assert.equal(await ask({ ...theirs, threads: [answered, ...newOnes] }), '2026-10-26T14:00:00Z');
    // a thread you commented in but didn't open counts too, and you answering last, or it being resolved, takes it away
    const joined = (resolved: boolean, last: string) =>
      thread(resolved, [
        comment('2026-10-26T09:00:00Z', them),
        comment('2026-10-26T09:30:00Z', user('octocat')),
        comment('2026-10-26T15:00:00Z', last === 'me' ? user('octocat') : them),
      ]);
    assert.equal(
      await ask({ ...theirs, threads: [joined(false, 'them')] }),
      '2026-10-26T15:00:00Z',
    );
    assert.equal(await ask({ ...theirs, threads: [joined(false, 'me')] }), null);
    assert.equal(await ask({ ...theirs, threads: [joined(true, 'them')] }), null);
    // a PR with no author in the answer is not taken for yours
    assert.equal(await ask({ author: '', threads: [ours, ...newOnes] }), null);
  }));

test('on your own PR, anyone’s new thread, a standing changes requested and a reply all come back to you', () =>
  withFakePr(async (ask) => {
    const bot = user('blafev');
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    // anyone's new thread, by a person
    assert.equal(
      await ask({ threads: [thread(false, [comment('2026-10-26T12:00:00Z', user('bobby'))])] }),
      '2026-10-26T12:00:00Z',
    );
    // a new thread the AI review opened, which counts when it opened the thread
    assert.equal(
      await ask({ threads: [thread(false, [comment('2026-10-26T12:30:00Z', bot, marker)])] }),
      '2026-10-26T12:30:00Z',
    );
    // another reviewer's standing changes requested
    assert.equal(
      await ask({
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-26T13:10:00Z',
            author: user('bobby'),
          },
        ],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'bobby' } }],
      }),
      '2026-10-26T13:10:00Z',
    );
    // a reply in a thread you were in, and the latest of all of them wins
    assert.equal(
      await ask({
        threads: [
          thread(false, [
            comment('2026-10-26T10:00:00Z', user('octocat')),
            comment('2026-10-26T16:00:00Z', user('bobby')),
          ]),
          thread(false, [comment('2026-10-26T12:00:00Z', user('bobby'))]),
        ],
      }),
      '2026-10-26T16:00:00Z',
    );
  }));

test('the required approvals are the strictest of branch protection and the rulesets, and the rules call asks for a full page', async () => {
  const dir = tmp('pr-required');
  const fake = path.join(dir, 'gh.mjs');
  // a gh that writes down the rules call's path, then answers it like fake-gh-pr-check.ts does
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv[3]?.startsWith('repos/')) {
  appendFileSync(process.env.FAKE_GH_CALLS, process.argv[3] + '\\n');
  process.stdout.write(readFileSync(process.env.FAKE_GH_RULES_JSON, 'utf8'));
} else {
  process.stdout.write(readFileSync(process.env.FAKE_GH_PR_JSON, 'utf8'));
}
`,
  );
  chmodSync(fake, 0o755);
  const calls = path.join(dir, 'calls.txt');
  const rules = path.join(dir, 'rules.json');
  const json = path.join(dir, 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH };
  Object.assign(process.env, {
    ONCE_UPON_GH: fake,
    FAKE_GH_CALLS: calls,
    FAKE_GH_RULES_JSON: rules,
    FAKE_GH_PR_JSON: json,
  });
  const required = async (protection: number | null, base: string) => {
    writeJson(json, {
      data: {
        viewer: { login: 'octocat' },
        repository: {
          pullRequest: {
            merged: false,
            state: 'OPEN',
            headRef: { id: 'ref1' },
            baseRefName: base,
            baseRef: {
              branchProtectionRule:
                protection === null ? null : { requiredApprovingReviewCount: protection },
              refUpdateRule: null,
            },
            reviews: { nodes: [] },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    return (await ghPrCheck('acme/widgets', 7)).info?.required;
  };
  try {
    writeJson(rules, [
      { type: 'deletion' },
      { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
    ]);
    assert.equal(await required(1, 'strict-rules'), 2, 'a stricter ruleset beats protection');
    assert.equal(
      await required(3, 'strict-protection'),
      3,
      'and a stricter protection beats the rules',
    );
    assert.equal(await required(null, 'rules-only'), 2);
    writeJson(rules, []);
    assert.equal(await required(1, 'protection-only'), 1);
    assert.equal(await required(null, 'neither'), null);
    assert.match(
      readFileSync(calls, 'utf8').split('\n')[0],
      /^repos\/acme\/widgets\/rules\/branches\/strict-rules\?per_page=100$/,
    );
  } finally {
    for (const name of ['FAKE_GH_CALLS', 'FAKE_GH_RULES_JSON', 'FAKE_GH_PR_JSON']) {
      delete process.env[name];
    }
    if (saved.gh === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = saved.gh;
    }
  }
});
