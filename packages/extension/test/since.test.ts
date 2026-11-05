import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFor, requestFor, type StoryStatus } from '../src/content/tag-model.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('the out-of-date tag offers Update (new commits) and Re-tell from scratch', () => {
  const pr = { repo: 'acme/widgets', number: 7 };
  const tag = tagFor({ state: 'ready', stale: true, story_head: SHA_A, current_head: SHA_B }, pr);
  assert.equal(tag.alt!.act, 'retell');
  assert.match(tag.title, /^Update \(new commits\)/);
  assert.match(tag.alt!.title, /^Re-tell from scratch/);
  assert.equal(requestFor(tag, pr).retell, undefined);
  assert.deepEqual(
    [requestFor(tag, pr, { retell: true }).mode, requestFor(tag, pr, { retell: true }).retell],
    ['update', true],
  );
  assert.equal(
    requestFor(tagFor({ state: 'none' }, pr), pr, { retell: true }).retell,
    undefined,
    'only an update can be a re-tell',
  );
});

test('"Since you read it" chapters finish their files and are not numbered', async () => {
  const { finishedInOf, chapterNumbers } = await import('@once-upon-a-diff/domain/chapters');
  const chapters = [
    {
      title: 'Since you read it: 1 new commit',
      since: { from: SHA_B, to: 'c'.repeat(40) },
      files: [{ rel: 'src/a.js' }],
    },
    {
      title: 'Since you read it: 2 new commits',
      since: { from: SHA_A, to: SHA_B },
      files: [{ rel: 'src/a.js' }, { rel: 'src/b.js' }],
    },
    { title: 'Chapter 1: Start', files: [{ rel: 'src/a.js' }] },
    {
      title: 'Chapter 2: Finish',
      files: [{ rel: 'src/a.js' }, { rel: 'src/b.js' }, { rel: 'src/c.js' }],
    },
  ];
  assert.deepEqual(
    chapterNumbers(chapters),
    [null, null, 1, 2],
    'the chapters he read keep their numbers',
  );
  assert.deepEqual(
    finishedInOf(chapters),
    { 'src/a.js': 1, 'src/b.js': 2, 'src/c.js': 4 },
    'the newest addendum wins; untouched files finish where they did',
  );
  assert.deepEqual(
    finishedInOf(chapters.slice(2)),
    { 'src/a.js': 2, 'src/b.js': 2, 'src/c.js': 2 },
    'without one, the last chapter that lists a file',
  );
});

test('GitHub\'s diff of a "Since you read it" chapter\'s commits opens on that chapter', async () => {
  const { rangeOfPath, rangeStepOf, rangeUrl } =
    await import('@once-upon-a-diff/panel/rebuild/freshness');
  const chapters = [
    { title: 'Since you read it', since: { from: SHA_A, to: SHA_B } },
    { title: 'Chapter 1: Start' },
  ];
  assert.deepEqual(rangeOfPath(`/acme/widgets/pull/7/files/${SHA_A}..${SHA_B}`), {
    from: SHA_A,
    to: SHA_B,
  });
  assert.deepEqual(rangeOfPath('/acme/widgets/pull/7/changes/aaaaaaa..bbbbbbb/'), {
    from: 'aaaaaaa',
    to: 'bbbbbbb',
  });
  for (const prCase of [
    '/acme/widgets/pull/7/files',
    '/acme/widgets/pull/7/changes',
    `/acme/widgets/pull/7/commits/${SHA_A}`,
  ]) {
    assert.equal(rangeOfPath(prCase), null, prCase);
  }
  assert.equal(
    rangeStepOf(chapters, '/acme/widgets/pull/7/files/aaaaaaa..bbbbbbb'),
    1,
    'short SHAs match the full ones',
  );
  assert.equal(rangeStepOf(chapters, `/acme/widgets/pull/7/files/${SHA_B}..${SHA_A}`), null);
  assert.equal(rangeStepOf(chapters, '/acme/widgets/pull/7/files'), null);
  assert.equal(
    rangeUrl('https://github.com/acme/widgets/pull/7', { from: SHA_A, to: SHA_B }),
    `https://github.com/acme/widgets/pull/7/changes/${SHA_A}..${SHA_B}`,
  );
  assert.equal(
    rangeUrl(null, { from: SHA_A, to: SHA_B }),
    null,
    'a local story has no GitHub link',
  );
});

test('the PR-list tag says how much of the story he has read', () => {
  const pr = { repo: 'acme/widgets', number: 7 };
  const href = 'https://github.com/acme/widgets/pull/7/changes';
  const tagWith = (result: StoryStatus) =>
    tagFor({ state: 'ready', story_head: SHA_A, ...result }, pr);
  assert.deepEqual(
    [tagWith({ reads: { read: 0, total: 5, next: 1 } }).label, tagWith({}).label],
    ['Story', 'Story'],
    'unread',
  );
  const part = tagWith({ reads: { read: 2, total: 5, next: 3 } });
  assert.deepEqual(
    [part.kind, part.label, part.href],
    ['link', 'Story · 2 of 5 read', `${href}#ou-step-3`],
    'partly read: to the first unread chapter',
  );
  const all = tagWith({ reads: { read: 5, total: 5, next: null } });
  assert.deepEqual([all.kind, all.label, all.cls, all.href], ['link', 'Read', 'read', href]);
  const moved = tagWith({
    reads: { read: 5, total: 5, next: null },
    stale: true,
    current_head: SHA_B,
    newer: 3,
  });
  assert.deepEqual(
    [moved.kind, moved.act, moved.label, moved.base, moved.alt!.act],
    ['button', 'update', 'Read · 3 new commits · Update', SHA_A, 'retell'],
  );
  assert.equal(
    tagWith({ reads: { read: 1, total: 5, next: 2 }, stale: true, newer: 1 }).label,
    '1 of 5 read · 1 new commit · Update',
  );
  assert.equal(
    tagWith({ reads: { read: 0, total: 5, next: 1 }, stale: true }).label,
    'Story out of date · Update',
    'unread but stale is as before',
  );
  assert.equal(
    tagFor(
      { state: 'ready', reads: { read: 5, total: 5 }, updating: true, update_state: 'queued' },
      pr,
    ).label,
    'Update queued',
    'queued and building win',
  );
});
