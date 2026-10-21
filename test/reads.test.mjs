import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson, localRepo } from './helpers.mjs';
import { chapterKey, noteRead, readReads, sinceOf } from '../bridge/lib/reads.mjs';
import { chapterKeyOf, readStepsOf, inferReadSteps } from '../src/js/shared/overlay.js';
import { clearFreshness } from '../bridge/lib/freshness.mjs';
import { createLocalStory } from '../bridge/lib/local.mjs';

process.env.DIFF_STORY_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const inbox = home => readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a chapter keeps its key when a chapter goes in front of it', () => {
  assert.equal(chapterKey({ title: 'Chapter 2: Finish' }), 'finish');
  assert.equal(chapterKey({ title: 'Chapter 3: Finish' }), 'finish', 'renumbering keeps the key');
  assert.equal(chapterKey({ title: 'Since you read it', key: 'since-abc1234-def5678' }), 'since-abc1234-def5678');
  for (const ch of [{ title: 'Chapter 1:  The  Start' }, { title: 'Overview of it' }, { key: ' k ', title: 'x' }]) assert.equal(chapterKeyOf(ch), chapterKey(ch), 'the panel and the bridge agree');
});

test('a later read of a chapter replaces the earlier one', () => {
  const home = tmp('home');
  noteRead(home, 'pr-acme-widgets-7', 'start', { head_sha: A, story_head: A, title: 'Chapter 1: Start', step: 1, seconds: 42 });
  noteRead(home, 'pr-acme-widgets-7', 'start', { head_sha: B, story_head: B, reason: 'viewed', title: 'Chapter 1: Start', step: 1 });
  const r = readReads(home, 'pr-acme-widgets-7');
  assert.deepEqual(Object.keys(r), ['start']);
  assert.equal(r.start.head_sha, B);
  assert.equal(r.start.reason, 'viewed');
  assert.equal(noteRead(home, 'k', 'x', { head_sha: 'not a sha' }).head_sha, null);
});

test('an update starts from the earliest chapter read, after the newest "Since you read it" he read', () => {
  const chapters = [{ key: 'since-b', title: 'Since you read it', since: { from: A, to: B } }, { key: 'start', title: 'Chapter 1: Start' }, { key: 'finish', title: 'Chapter 2: Finish' }];
  const at = s => new Date(Date.parse('2026-10-21T15:00:00Z') + s * 1000).toISOString();
  assert.deepEqual(sinceOf({}, chapters, A), { since_sha: A, source: 'story', chapter: null, at: null, read: [] }, 'nothing read: from the story head');
  assert.equal(sinceOf({}, chapters, null).since_sha, null);
  const reads = { start: { story_head: A, head_sha: A, at: at(0) }, finish: { story_head: B, head_sha: B, at: at(10) } };
  assert.equal(sinceOf(reads, chapters, C).since_sha, A, 'the earliest read');
  assert.equal(sinceOf({ ...reads, 'since-b': { story_head: B, at: at(5) } }, chapters, C).since_sha, B, 'reading the addendum caught him up to its commit');
  assert.equal(sinceOf({ gone: { story_head: A, at: at(0) } }, chapters, C).since_sha, C, 'a chapter that is no longer in the story does not count');
  assert.equal(sinceOf({ start: { story_head: A, head_sha: B, at: at(0) } }, chapters, C).since_sha, A, 'a stale story was read: what it told him, not the head he saw');
});

test('the bridge records a read with the PR head, and lists them', async () => {
  clearFreshness();
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  writeJson(path.join(dir, 'meta.json'), { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: A });
  const b = await startBridge({ home });
  try {
    const story = (await b.call('GET', '/api/stories/acme-widgets-7')).body;
    assert.deepEqual(story.chapters.map(c => c.key), ['start', 'finish', 'not in a chapter yet'], 'README.md is placed nowhere');
    // the panel didn't know the head: the bridge asks gh (the fake PR is at B), and keeps the story's own head too
    const r = await b.call('POST', '/api/stories/acme-widgets-7/read', { chapter: 'start', step: 1, reason: 'time', seconds: 95 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.head_sha, r.body.story_head, r.body.reason, r.body.seconds, r.body.title], [B, A, 'time', 95, 'Chapter 1: Start']);
    const seen = (await b.call('POST', '/api/stories/acme-widgets-7/read', { chapter: 'finish', step: 2, reason: 'viewed', head_sha: C })).body;
    assert.equal(seen.head_sha, C, 'the head the panel saw wins');
    assert.equal((await b.call('POST', '/api/stories/acme-widgets-7/read', { chapter: 'nope' })).status, 404);
    const saved = JSON.parse(readFileSync(path.join(home, 'state', 'pr-acme-widgets-7', 'read.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved), ['start', 'finish'], 'kept per PR, like drafts.json');
    assert.deepEqual(inbox(home).filter(e => e.type === 'read').map(e => [e.chapter, e.head_sha]), [['start', B], ['finish', C]]);
    const list = (await b.call('GET', '/api/stories/acme-widgets-7/read')).body;
    assert.deepEqual(Object.keys(list.reads), ['start', 'finish']);
    assert.equal(list.since.since_sha, A, 'chapter 1 was read first, against the story told from A');
  } finally { await b.close(); }
});

test('a local story records the head commit of its range', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-x' });
  const b = await startBridge({ home });
  try {
    const story = (await b.call('GET', `/api/stories/${made.id}`)).body;
    const r = (await b.call('POST', `/api/stories/${made.id}/read`, { chapter: story.chapters[0].key, step: 1, reason: 'time' })).body;
    assert.equal(r.head_sha, story.local.head_oid);
    assert.equal(r.story_head, story.local.head_oid);
  } finally { await b.close(); }
});

test('chapters he read are marked when a newer commit changed their files, and drafts on a changed line', async () => {
  const { changedSinceRead } = await import('../bridge/lib/reads.mjs');
  const chapters = [
    { key: 'since-x', since: { from: A, to: B }, files: [{ rel: 'src/a.js' }], comments: [{ path: 'src/a.js', line: 5, body: 'new' }] },
    { key: 'start', files: [{ rel: 'src/a.js' }], comments: [{ path: 'src/a.js', line: 12, body: 'on a changed line' }, { path: 'src/a.js', line: 40, body: 'far away' }, { path: '(general)', line: 0, body: 'general' }] },
    { key: 'finish', files: [{ rel: 'src/b.js' }], comments: [{ path: 'src/b.js', line: 3, body: 'file renamed' }] },
    { key: 'unread', files: [{ rel: 'src/a.js' }] },
  ];
  const reads = { start: { story_head: A }, finish: { story_head: A }, 'since-x': { story_head: B } };
  const changes = new Map([[A, new Map([['src/a.js', { kind: 'modified', hunks: [{ oldStart: 10, oldLines: 7 }] }], ['src/b.js', { kind: 'renamed', hunks: [] }]])]]);
  const r = changedSinceRead(chapters, reads, changes, B);
  assert.deepEqual(r.changed, [{ step: 2, chapter: 'start', since: A, files: ['src/a.js'] }, { step: 3, chapter: 'finish', since: A, files: ['src/b.js'] }], 'not the addendum, not a chapter never read');
  assert.deepEqual(r.stale_comments.map(c => [c.step, c.index]), [[2, 0], [3, 0]]);
  assert.deepEqual(changedSinceRead(chapters, { start: { story_head: B } }, changes, B), { changed: [], stale_comments: [] }, 'read at the story head: nothing to mark');
});

test('GET /read compares the commit each chapter was read at with the story head (gh for a PR)', async () => {
  clearFreshness();
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  writeJson(path.join(dir, 'meta.json'), { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: B });
  const extra = path.join(home, 'gh-extra.json');
  writeJson(extra, { [`repos/acme/widgets/compare/${A}...${B}`]: { status: 'ahead', ahead_by: 1, files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,4 +1,5 @@\n a\n-b\n+B\n+C\n c' }] } });
  process.env.DIFF_STORY_FAKE_GH_EXTRA = extra;
  noteRead(home, 'pr-acme-widgets-7', 'start', { head_sha: A, story_head: A });
  const b = await startBridge({ home });
  try {
    const r = (await b.call('GET', '/api/stories/acme-widgets-7/read')).body;
    assert.equal(r.error, null);
    assert.deepEqual(r.changed, [{ step: 1, chapter: 'start', since: A, files: ['src/a.js'] }]);
    assert.deepEqual(r.stale_comments.map(c => [c.step, c.index, c.line]), [[1, 0, 2]], 'the drafted comment on line 2 sits in the changed hunk');
  } finally { delete process.env.DIFF_STORY_FAKE_GH_EXTRA; await b.close(); }
});

test('a local story compares with git', async () => {
  const { git } = await import('./helpers.mjs');
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-y' });
  const b = await startBridge({ home });
  try {
    const story = (await b.call('GET', `/api/stories/${made.id}`)).body;
    const ch = story.chapters.find(c => c.files.some(f => f.rel === 'one.txt'));
    await b.call('POST', `/api/stories/${made.id}/read`, { chapter: ch.key, reason: 'time' });
    writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
    git(repo, 'commit', '-q', '-am', 'more one');
    const r = (await b.call('GET', `/api/stories/${made.id}/read`)).body;
    assert.deepEqual(r.changed.map(c => c.files), [['one.txt']]);
    assert.notEqual(r.story_head, r.reads[ch.key].head_sha, 'the story followed the branch');
  } finally { await b.close(); }
});

test('a chapter he has read, and that has not changed since, does not make its files "viewed early"', () => {
  const chapters = [{ title: 'Chapter 1: Logging in' }, { title: 'Chapter 2: The task' }, { title: 'Chapter 3: Dependencies and CI' }];
  assert.deepEqual([...readStepsOf(chapters, null)], [], 'nothing known: no chapter counts as read');
  const reads = { 'dependencies and ci': { head_sha: A, story_head: A, at: '2026-10-21T19:28:03Z' }, 'the task': { head_sha: A, story_head: A, at: '2026-10-21T19:39:20Z' } };
  assert.deepEqual([...readStepsOf(chapters, { reads })].sort(), [2, 3]);
  assert.deepEqual([...readStepsOf(chapters, { reads, changed: [{ step: 3, files: ['yarn.lock'] }] })], [2], 'a chapter that changed after he read it is due again');
});

test('a chapter whose files were all Viewed when the page first showed them counts as read, once', () => {
  const chapters = [{ title: 'Chapter 1: Logging in' }, { title: 'Chapter 2: The task' }, { title: 'Chapter 3: Dependencies and CI' }];
  const p = (due, viewed, unknown = []) => ({ due, viewed, unknown, noToggle: false });
  const look = new Map();
  assert.deepEqual(inferReadSteps(chapters, [p(2, 2), p(3, 3), p(3, 3)], null, look), [], 'nothing until read.json has loaded');
  assert.equal(look.size, 0);
  const readInfo = { reads: { 'the task': { head_sha: A, at: '2026-10-21T19:39:20Z' } } };
  assert.deepEqual(inferReadSteps(chapters, [p(2, 2), p(3, 3), p(3, 2, ['yarn.lock'])], readInfo, look), [1], 'chapter 2 is already read; chapter 3 is not all loaded yet');
  assert.deepEqual(inferReadSteps(chapters, [p(2, 2), p(3, 3), p(3, 3)], readInfo, look), [3], 'chapter 3 once its files load');
  assert.deepEqual(inferReadSteps(chapters, [p(2, 2), p(3, 3), p(3, 3)], readInfo, look), [], 'each chapter is looked at once');
  const fresh = new Map();
  assert.deepEqual(inferReadSteps(chapters, [p(2, 0), p(0, 0), p(3, 1)], { reads: {} }, fresh), [], 'not all Viewed, or nothing to view: not read');
  assert.deepEqual(inferReadSteps(chapters, [p(2, 2), p(0, 0), p(3, 3)], { reads: {} }, fresh), [], 'ticking them all later is not the first look');
});

test('an inferred read is kept with its reason', () => {
  const home = tmp('home');
  assert.equal(noteRead(home, 'k', 'start', { head_sha: A, story_head: A, reason: 'inferred' }).reason, 'inferred');
  assert.equal(noteRead(home, 'k', 'start', { head_sha: A, reason: 'made up' }).reason, 'time');
});
