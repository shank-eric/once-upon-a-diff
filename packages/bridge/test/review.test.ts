// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.ts';
import { addToPendingReview } from '../src/github/review.ts';
import { clearCache } from '../src/github/drafts.ts';
import { draftView, shownIn } from '@once-upon-a-diff/shared/overlay';

const fake = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh-review.ts',
);
chmodSync(fake, 0o755);

function withFake(env, run) {
  const saved = {
    gh: process.env.ONCE_UPON_GH,
    log: process.env.FAKE_GH_LOG,
    pending: process.env.FAKE_GH_PENDING,
  };
  const log = path.join(tmp('gh'), 'calls.jsonl');
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_LOG = log;
  if (env.pending) {
    process.env.FAKE_GH_PENDING = '1';
  } else {
    delete process.env.FAKE_GH_PENDING;
  }
  const restore = () => {
    for (const [k, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_LOG', saved.log],
      ['FAKE_GH_PENDING', saved.pending],
    ]) {
      if (value === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = value;
      }
    }
  };
  return run(() =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).finally(restore);
}
const queryOf = (call) => call.find((arg) => arg.startsWith('query='));

test('starts a pending review when none exists, then adds the thread; never submits', () =>
  withFake({}, async (calls) => {
    const result = await addToPendingReview('acme/widgets', 7, {
      path: 'src/a.js',
      line: 12,
      body: 'Could you confirm this?',
    });
    assert.equal(result.started, true);
    assert.equal(result.review, 'PRR_new');
    assert.match(result.url, /discussion_r1/);
    const queries = calls().map(queryOf);
    assert.equal(queries.length, 3);
    assert.ok(queries[1].includes('addPullRequestReview('));
    for (const query of queries) {
      assert.ok(
        !/submitPullRequestReview|event:|APPROVE|REQUEST_CHANGES|addPullRequestReviewComment|addComment\(/.test(
          query,
        ),
        'nothing that submits or posts',
      );
    }
  }));

test('reuses his existing pending review and sends RIGHT side by default', () =>
  withFake({ pending: true }, async (calls) => {
    const result = await addToPendingReview('acme/widgets', 7, {
      path: 'src/a.js',
      line: 12,
      body: 'x',
    });
    assert.equal(result.started, false);
    assert.equal(result.review, 'PRR_old');
    const thread = calls()[1];
    assert.ok(thread.includes('review=PRR_old'));
    assert.ok(thread.includes('side=RIGHT'));
  }));

test('general comments and empty drafts are refused without calling gh', () =>
  withFake({}, async () => {
    await assert.rejects(
      addToPendingReview('acme/widgets', 7, { path: '', line: 0, body: 'general' }),
      /only line comments/,
    );
    await assert.rejects(
      addToPendingReview('acme/widgets', 7, { path: 'a.js', line: 3, body: '  ' }),
      /empty/,
    );
  }));

// ---------- after Add to my review: the panel's "added" state, kept by the bridge until the page shows it
const fakeAll = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.ts');
chmodSync(fakeAll, 0o755);
function withBridgeGh(env, run) {
  const keys = [
    'ONCE_UPON_GH',
    'FAKE_GH_GRAPHQL',
    'FAKE_GH_FAIL',
    'FAKE_GH_LOG',
    'FAKE_GH_PENDING',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.ONCE_UPON_GH = fakeAll;
  process.env.FAKE_GH_GRAPHQL = '1';
  delete process.env.FAKE_GH_LOG;
  delete process.env.FAKE_GH_PENDING;
  if (env.fail) {
    process.env.FAKE_GH_FAIL = '1';
  } else {
    delete process.env.FAKE_GH_FAIL;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const k of keys) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    });
}
function onceUpon(home) {
  githubStory(path.join(home, 'acme-widgets-7'));
  writeJson(path.join(home, 'acme-widgets-7', 'chapters.json'), {
    title: 'Widgets',
    chapters: [
      {
        title: 'Chapter 1: Start',
        files: ['src/a.js', 'README.md'],
        comments: [
          { path: 'README.md', line: 4, body: 'Typo: "teh".' },
          { path: '(general)', line: 0, body: 'Thanks for this.' },
        ],
      },
    ],
  });
}

test('a draft added to the review is kept as added across calls and a bridge restart, and settles once', () =>
  withBridgeGh({}, async () => {
    clearCache();
    const home = tmp('home');
    onceUpon(home);
    let bridge = await startBridge({ home });
    try {
      const response = await bridge.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'review',
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.added.url, 'https://github.com/acme/widgets/pull/7#discussion_r1');
      const row = response.body.drafts[0];
      assert.equal(
        row.status,
        'draft',
        "gh doesn't match it in this fixture, so only the added mark says where it went",
      );
      assert.equal(row.added.url, 'https://github.com/acme/widgets/pull/7#discussion_r1');
      assert.ok(Date.parse(row.added.at) > 0);
      assert.equal(response.body.drafts[1].added, null);
      // a second click (or another tab) doesn't put a second copy in the review
      const again = await bridge.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'review',
      });
      assert.equal(again.status, 409);
      assert.match(again.body.error, /already in your pending review/);
    } finally {
      await bridge.close();
    }

    bridge = await startBridge({ home }); // the bridge restarted
    try {
      let state = (await bridge.call('GET', '/api/stories/acme-widgets-7/drafts')).body;
      assert.ok(state.drafts[0].added, 'still added after a restart');
      state = (
        await bridge.call('POST', '/api/stories/acme-widgets-7/drafts', {
          chapter: 1,
          index: 0,
          action: 'settle',
        })
      ).body;
      assert.equal(
        state.drafts[0].added,
        null,
        'settle drops the mark once the page or gh shows the comment',
      );
    } finally {
      await bridge.close();
    }
  }));

test('when GitHub refuses, the error comes back and nothing is marked added', () =>
  withBridgeGh({ fail: true }, async () => {
    clearCache();
    const home = tmp('home');
    onceUpon(home);
    const bridge = await startBridge({ home });
    try {
      const response = await bridge.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'review',
      });
      assert.equal(response.status, 502);
      assert.match(
        response.body.error,
        /couldn't add it to your review: GraphQL: Line could not be resolved/,
      );
      const state = (await bridge.call('GET', '/api/stories/acme-widgets-7/drafts')).body;
      assert.equal(state.drafts[0].added, null);
      assert.equal(
        state.drafts[0].status,
        'draft',
        'still a draft, so Add to my review is offered again',
      );
    } finally {
      await bridge.close();
    }
  }));

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
