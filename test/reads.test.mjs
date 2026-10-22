import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson, localRepo } from './helpers.mjs';
import { chapterKey, noteRead, readReads, sinceOf } from '../bridge/stories/reads.mjs';
import {
  chapterKeyOf,
  finishedInOf,
  inferReadSteps,
  viewedEarlyCheck,
} from '../src/js/shared/overlay.js';
import { clearFreshness } from '../bridge/github/freshness.mjs';
import { createLocalStory } from '../bridge/stories/local-story.mjs';

process.env.DIFF_STORY_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh.mjs',
);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const inbox = (home) =>
  readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a chapter keeps its key when a chapter goes in front of it', () => {
  assert.equal(chapterKey({ title: 'Chapter 2: Finish' }), 'finish');
  assert.equal(chapterKey({ title: 'Chapter 3: Finish' }), 'finish', 'renumbering keeps the key');
  assert.equal(
    chapterKey({ title: 'Since you read it', key: 'since-abc1234-def5678' }),
    'since-abc1234-def5678',
  );
  for (const chapter of [
    { title: 'Chapter 1:  The  Start' },
    { title: 'Overview of it' },
    { key: ' k ', title: 'x' },
  ]) {
    assert.equal(chapterKeyOf(chapter), chapterKey(chapter), 'the panel and the bridge agree');
  }
});

test('a later read of a chapter replaces the earlier one', () => {
  const home = tmp('home');
  noteRead(home, 'pr-acme-widgets-7', 'start', {
    head_sha: SHA_A,
    story_head: SHA_A,
    title: 'Chapter 1: Start',
    step: 1,
    seconds: 42,
  });
  noteRead(home, 'pr-acme-widgets-7', 'start', {
    head_sha: SHA_B,
    story_head: SHA_B,
    reason: 'viewed',
    title: 'Chapter 1: Start',
    step: 1,
  });
  const reads = readReads(home, 'pr-acme-widgets-7');
  assert.deepEqual(Object.keys(reads), ['start']);
  assert.equal(reads.start.head_sha, SHA_B);
  assert.equal(reads.start.reason, 'viewed');
  assert.equal(noteRead(home, 'k', 'x', { head_sha: 'not a sha' }).head_sha, null);
});

test('an update starts from the earliest chapter read, after the newest "Since you read it" he read', () => {
  const chapters = [
    { key: 'since-b', title: 'Since you read it', since: { from: SHA_A, to: SHA_B } },
    { key: 'start', title: 'Chapter 1: Start' },
    { key: 'finish', title: 'Chapter 2: Finish' },
  ];
  const isoAt = (seconds) =>
    new Date(Date.parse('2026-10-21T15:00:00Z') + seconds * 1000).toISOString();
  assert.deepEqual(
    sinceOf({}, chapters, SHA_A),
    { since_sha: SHA_A, source: 'story', chapter: null, at: null, read: [] },
    'nothing read: from the story head',
  );
  assert.equal(sinceOf({}, chapters, null).since_sha, null);
  const reads = {
    start: { story_head: SHA_A, head_sha: SHA_A, at: isoAt(0) },
    finish: { story_head: SHA_B, head_sha: SHA_B, at: isoAt(10) },
  };
  assert.equal(sinceOf(reads, chapters, SHA_C).since_sha, SHA_A, 'the earliest read');
  assert.equal(
    sinceOf({ ...reads, 'since-b': { story_head: SHA_B, at: isoAt(5) } }, chapters, SHA_C)
      .since_sha,
    SHA_B,
    'reading the addendum caught him up to its commit',
  );
  assert.equal(
    sinceOf({ gone: { story_head: SHA_A, at: isoAt(0) } }, chapters, SHA_C).since_sha,
    SHA_C,
    'a chapter that is no longer in the story does not count',
  );
  assert.equal(
    sinceOf({ start: { story_head: SHA_A, head_sha: SHA_B, at: isoAt(0) } }, chapters, SHA_C)
      .since_sha,
    SHA_A,
    'a stale story was read: what it told him, not the head he saw',
  );
});

test('the bridge records a read with the PR head, and lists them', async () => {
  clearFreshness();
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir, { meta: { head_oid: SHA_A } });
  const bridge = await startBridge({ home });
  try {
    const story = (await bridge.call('GET', '/api/stories/acme-widgets-7')).body;
    assert.deepEqual(
      story.chapters.map((chapter) => chapter.key),
      ['start', 'finish', 'not in a chapter yet'],
      'README.md is placed nowhere',
    );
    // the panel didn't know the head: the bridge asks gh (the fake PR is at B), and keeps the story's own head too
    const response = await bridge.call('POST', '/api/stories/acme-widgets-7/read', {
      chapter: 'start',
      step: 1,
      reason: 'time',
      seconds: 95,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      [
        response.body.head_sha,
        response.body.story_head,
        response.body.reason,
        response.body.seconds,
        response.body.title,
      ],
      [SHA_B, SHA_A, 'time', 95, 'Chapter 1: Start'],
    );
    const seen = (
      await bridge.call('POST', '/api/stories/acme-widgets-7/read', {
        chapter: 'finish',
        step: 2,
        reason: 'viewed',
        head_sha: SHA_C,
      })
    ).body;
    assert.equal(seen.head_sha, SHA_C, 'the head the panel saw wins');
    assert.equal(
      (await bridge.call('POST', '/api/stories/acme-widgets-7/read', { chapter: 'nope' })).status,
      404,
    );
    const saved = JSON.parse(
      readFileSync(path.join(home, 'state', 'pr-acme-widgets-7', 'read.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(saved), ['start', 'finish'], 'kept per PR, like drafts.json');
    assert.deepEqual(
      inbox(home)
        .filter((e) => e.type === 'read')
        .map((e) => [e.chapter, e.head_sha]),
      [
        ['start', SHA_B],
        ['finish', SHA_C],
      ],
    );
    const list = (await bridge.call('GET', '/api/stories/acme-widgets-7/read')).body;
    assert.deepEqual(Object.keys(list.reads), ['start', 'finish']);
    assert.equal(
      list.since.since_sha,
      SHA_A,
      'chapter 1 was read first, against the story told from A',
    );
  } finally {
    await bridge.close();
  }
});

test('a local story records the head commit of its range', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-x' });
  const bridge = await startBridge({ home });
  try {
    const story = (await bridge.call('GET', `/api/stories/${made.id}`)).body;
    const result = (
      await bridge.call('POST', `/api/stories/${made.id}/read`, {
        chapter: story.chapters[0].key,
        step: 1,
        reason: 'time',
      })
    ).body;
    assert.equal(result.head_sha, story.local.head_oid);
    assert.equal(result.story_head, story.local.head_oid);
  } finally {
    await bridge.close();
  }
});

test('chapters he read are marked when a newer commit changed their files, and drafts on a changed line', async () => {
  const { changedSinceRead } = await import('../bridge/stories/reads.mjs');
  const chapters = [
    {
      key: 'since-x',
      since: { from: SHA_A, to: SHA_B },
      files: [{ rel: 'src/a.js' }],
      comments: [{ path: 'src/a.js', line: 5, body: 'new' }],
    },
    {
      key: 'start',
      files: [{ rel: 'src/a.js' }],
      comments: [
        { path: 'src/a.js', line: 12, body: 'on a changed line' },
        { path: 'src/a.js', line: 40, body: 'far away' },
        { path: '(general)', line: 0, body: 'general' },
      ],
    },
    {
      key: 'finish',
      files: [{ rel: 'src/b.js' }],
      comments: [{ path: 'src/b.js', line: 3, body: 'file renamed' }],
    },
    { key: 'unread', files: [{ rel: 'src/a.js' }] },
  ];
  const reads = {
    start: { story_head: SHA_A },
    finish: { story_head: SHA_A },
    'since-x': { story_head: SHA_B },
  };
  const changes = new Map([
    [
      SHA_A,
      new Map([
        ['src/a.js', { kind: 'modified', hunks: [{ oldStart: 10, oldLines: 7 }] }],
        ['src/b.js', { kind: 'renamed', hunks: [] }],
      ]),
    ],
  ]);
  const result = changedSinceRead(chapters, reads, changes, SHA_B);
  assert.deepEqual(
    result.changed,
    [
      { step: 2, chapter: 'start', since: SHA_A, files: ['src/a.js'] },
      { step: 3, chapter: 'finish', since: SHA_A, files: ['src/b.js'] },
    ],
    'not the addendum, not a chapter never read',
  );
  assert.deepEqual(
    result.stale_comments.map((comment) => [comment.step, comment.index]),
    [
      [2, 0],
      [3, 0],
    ],
  );
  assert.deepEqual(
    changedSinceRead(chapters, { start: { story_head: SHA_B } }, changes, SHA_B),
    { changed: [], stale_comments: [] },
    'read at the story head: nothing to mark',
  );
});

test('GET /read compares the commit each chapter was read at with the story head (gh for a PR)', async () => {
  clearFreshness();
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir, { meta: { head_oid: SHA_B } });
  const extra = path.join(home, 'gh-extra.json');
  writeJson(extra, {
    [`repos/acme/widgets/compare/${SHA_A}...${SHA_B}`]: {
      status: 'ahead',
      ahead_by: 1,
      files: [
        { filename: 'src/a.js', status: 'modified', patch: '@@ -1,4 +1,5 @@\n a\n-b\n+B\n+C\n c' },
      ],
    },
  });
  process.env.DIFF_STORY_FAKE_GH_EXTRA = extra;
  noteRead(home, 'pr-acme-widgets-7', 'start', { head_sha: SHA_A, story_head: SHA_A });
  const bridge = await startBridge({ home });
  try {
    const result = (await bridge.call('GET', '/api/stories/acme-widgets-7/read')).body;
    assert.equal(result.error, null);
    assert.deepEqual(result.changed, [
      { step: 1, chapter: 'start', since: SHA_A, files: ['src/a.js'] },
    ]);
    assert.deepEqual(
      result.stale_comments.map((comment) => [comment.step, comment.index, comment.line]),
      [[1, 0, 2]],
      'the drafted comment on line 2 sits in the changed hunk',
    );
  } finally {
    delete process.env.DIFF_STORY_FAKE_GH_EXTRA;
    await bridge.close();
  }
});

test('a local story compares with git', async () => {
  const { git } = await import('./helpers.mjs');
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-y' });
  const bridge = await startBridge({ home });
  try {
    const story = (await bridge.call('GET', `/api/stories/${made.id}`)).body;
    const chapter = story.chapters.find((candidate) =>
      candidate.files.some((file) => file.rel === 'one.txt'),
    );
    await bridge.call('POST', `/api/stories/${made.id}/read`, {
      chapter: chapter.key,
      reason: 'time',
    });
    writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
    git(repo, 'commit', '-q', '-am', 'more one');
    const result = (await bridge.call('GET', `/api/stories/${made.id}/read`)).body;
    assert.deepEqual(
      result.changed.map((change) => change.files),
      [['one.txt']],
    );
    assert.notEqual(
      result.story_head,
      result.reads[chapter.key].head_sha,
      'the story followed the branch',
    );
  } finally {
    await bridge.close();
  }
});

test('a chapter he has read, and that has not changed since, does not make its files "viewed early"', () => {
  const chapters = [
    { title: 'Chapter 1: Logging in', files: [{ rel: 'login.js' }] },
    { title: 'Chapter 2: The task', files: [{ rel: 'task.js' }] },
    { title: 'Chapter 3: Dependencies and CI', files: [{ rel: 'yarn.lock' }, { rel: 'ci.yml' }] },
  ];
  const finishedIn = finishedInOf(chapters);
  const earlyOn = (step, readInfo) =>
    ['login.js', 'task.js', 'yarn.lock', 'ci.yml'].filter(
      viewedEarlyCheck({ chapters, finishedIn, readInfo, step }),
    );
  assert.deepEqual(earlyOn(1, null), ['task.js', 'yarn.lock', 'ci.yml'], 'nothing read yet');
  assert.deepEqual(earlyOn(0, null), [], 'nothing is early on the Overview');
  const reads = {
    'dependencies and ci': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T19:28:03Z' },
    'the task': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T19:39:20Z' },
  };
  assert.deepEqual(earlyOn(1, { reads }), []);
  assert.deepEqual(
    earlyOn(1, { reads, changed: [{ step: 3, files: ['yarn.lock'] }] }),
    ['yarn.lock'],
    'a file that changed after he read its chapter is due again, and only that file',
  );
  assert.deepEqual(
    earlyOn(1, { reads, changed: [{ step: 3 }] }),
    ['yarn.lock', 'ci.yml'],
    'a change that names no files counts for the whole chapter',
  );
});

test('a "Since you read it" chapter first does not make the chapters he read "viewed early"', () => {
  // EverFi/everfi-frontend#6943 on 10/22: one new commit changed useApiOptions.ts, which chapter 2 also lists. The
  // bridge then reports chapter 2 as changed since he read it, but its other files, still Viewed, are as he read them.
  const chapters = [
    {
      key: 'since-6180a7a-1d8180f',
      title: 'Since you read it: 1 new commit',
      since: { from: SHA_A, to: SHA_B, commits: 1 },
      files: [{ rel: 'useApiOptions.ts' }],
    },
    { title: 'Chapter 1: The timeline select', files: [{ rel: 'TimelineField.tsx' }] },
    {
      title: 'Chapter 2: Where the options come from',
      files: [{ rel: 'useApiOptions.ts' }, { rel: 'index.ts' }, { rel: 'useQualifiOptions.ts' }],
    },
  ];
  const finishedIn = finishedInOf(chapters);
  const reads = {
    'the timeline select': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T20:20:41Z' },
    'where the options come from': {
      head_sha: SHA_A,
      story_head: SHA_A,
      at: '2026-10-21T19:56:14Z',
    },
  };
  const readInfo = { reads, changed: [{ step: 3, files: ['useApiOptions.ts'] }] };
  const all = ['useApiOptions.ts', 'TimelineField.tsx', 'index.ts', 'useQualifiOptions.ts'];
  const earlyOn = (step, info) =>
    all.filter(viewedEarlyCheck({ chapters, finishedIn, readInfo: info, step }));
  assert.deepEqual(
    earlyOn(2, readInfo),
    [],
    'chapter 1: chapter 2 is read apart from the new file',
  );
  assert.deepEqual(
    earlyOn(1, { reads: {} }),
    [],
    'nothing is early on the "Since you read it" step, read or not',
  );
  assert.deepEqual(
    earlyOn(2, { reads: {} }),
    ['index.ts', 'useQualifiOptions.ts'],
    'an old chapter not read yet still warns from the one before it',
  );
});

test('a chapter whose files were all Viewed when the page first showed them counts as read, once', () => {
  const chapters = [
    { title: 'Chapter 1: Logging in' },
    { title: 'Chapter 2: The task' },
    { title: 'Chapter 3: Dependencies and CI' },
  ];
  const progress = (due, viewed, unknown = []) => ({ due, viewed, unknown, noToggle: false });
  const look = new Map();
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], null, look),
    [],
    'nothing until read.json has loaded',
  );
  assert.equal(look.size, 0);
  const readInfo = { reads: { 'the task': { head_sha: SHA_A, at: '2026-10-21T19:39:20Z' } } };
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 2), progress(3, 3), progress(3, 2, ['yarn.lock'])],
      readInfo,
      look,
    ),
    [1],
    'chapter 2 is already read; chapter 3 is not all loaded yet',
  );
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], readInfo, look),
    [3],
    'chapter 3 once its files load',
  );
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], readInfo, look),
    [],
    'each chapter is looked at once',
  );
  const fresh = new Map();
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 0), progress(0, 0), progress(3, 1)],
      { reads: {} },
      fresh,
    ),
    [],
    'not all Viewed, or nothing to view: not read',
  );
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 2), progress(0, 0), progress(3, 3)],
      { reads: {} },
      fresh,
    ),
    [],
    'ticking them all later is not the first look',
  );
});

test('an inferred read is kept with its reason', () => {
  const home = tmp('home');
  assert.equal(
    noteRead(home, 'k', 'start', { head_sha: SHA_A, story_head: SHA_A, reason: 'inferred' }).reason,
    'inferred',
  );
  assert.equal(noteRead(home, 'k', 'start', { head_sha: SHA_A, reason: 'made up' }).reason, 'time');
});
