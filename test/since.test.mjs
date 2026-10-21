import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.mjs';
import { Builds, buildText } from '../bridge/lib/builds.mjs';
import { Inbox } from '../bridge/lib/inbox.mjs';
import { noteRead } from '../bridge/lib/reads.mjs';
import { clearFreshness } from '../bridge/lib/freshness.mjs';
import { tagFor, tagHtml, requestFor } from '../src/js/content/tag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.DIFF_STORY_GH = path.join(HERE, 'fixtures', 'fake-gh.mjs');
const BIN = path.resolve(HERE, '../bridge/bin/diff-story.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const inbox = (home) =>
  readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const cli = (home, args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, DIFF_STORY_HOME: home } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

function story(home, head = A) {
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
    head_oid: head,
  });
  return dir;
}

test('an update asks for a "Since you read it" chapter from where the reading stopped', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  const C = 'c'.repeat(40);
  noteRead(home, 'pr-acme-widgets-7', 'finish', {
    head_sha: C,
    story_head: C,
    title: 'Chapter 2: Finish',
  });
  await new Promise((r) => setTimeout(r, 5));
  noteRead(home, 'pr-acme-widgets-7', 'start', {
    head_sha: A,
    story_head: A,
    title: 'Chapter 1: Start',
  });
  const b = await startBridge({ home });
  try {
    const r = (
      await b.call('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: A,
      })
    ).body.request;
    assert.deepEqual(
      [r.mode, r.since_sha, r.since_source, r.story, !!r.retell],
      ['update', C, 'read', 'acme-widgets-7', false],
      'the earliest read was chapter 2, at C',
    );
    assert.deepEqual(r.reads.map((x) => x.chapter).sort(), ['finish', 'start']);
    const line = inbox(home).find((e) => e.type === 'build_request');
    assert.equal(line.since_sha, C);
    assert.match(
      line.text,
      /"Since you read it" chapter first for ccccccc\.\.the PR's head, where the reviewer's reading stopped/,
    );
    // the wait hands it over with the same fields
    const w = await cli(home, ['wait', '--timeout', '1', '--json', '--repo', 'acme/widgets']);
    const e = JSON.parse(w.stdout.trim().split('\n')[0]);
    assert.deepEqual(
      [e.mode, e.since_sha, e.retell, e.story],
      ['update', C, false, 'acme-widgets-7'],
    );
    const listed = await cli(home, ['builds']);
    assert.match(
      listed.stdout,
      /update: "Since you read it" from ccccccc \(where the reviewer's reading stopped; 2 chapters read\)/,
    );
    // display_name in config.json names the reviewer
    writeJson(path.join(home, 'config.json'), {
      ...JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')),
      display_name: 'Sam',
    });
    assert.match(
      (await cli(home, ['builds'])).stdout,
      /\(where Sam's reading stopped; 2 chapters read\)/,
    );
    assert.equal(JSON.parse((await cli(home, ['builds', '--json'])).stdout)[0].since_sha, C);
  } finally {
    await b.close();
  }
});

test('with nothing read, an update starts from the story head; Re-tell asks for a new story', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  const b = await startBridge({ home });
  try {
    const r = (
      await b.call('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: A,
      })
    ).body.request;
    assert.deepEqual([r.since_sha, r.since_source, r.reads.length], [A, 'story', 0]);
    // still queued: Re-tell from scratch replaces it, and Update (new commits) puts it back
    const re = (
      await b.call('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: A,
        retell: true,
      })
    ).body.request;
    assert.equal(re.id, r.id, 'the same request');
    assert.equal(re.retell, true);
    assert.match(
      inbox(home)
        .filter((e) => e.type === 'build_request')
        .at(-1).text,
      /^Re-tell the story for acme\/widgets#7 from scratch/,
    );
    assert.equal(
      (
        await b.call('POST', '/api/builds', {
          repo: 'acme/widgets',
          number: 7,
          mode: 'update',
          base_sha: A,
        })
      ).body.request.retell,
      undefined,
    );
  } finally {
    await b.close();
  }
});

test('once a session has claimed an update, a second click does not change it', () => {
  const home = tmp('home');
  const builds = new Builds(home, new Inbox(home));
  const r = builds.request({
    repo: 'acme/widgets',
    number: 7,
    mode: 'update',
    base_sha: A,
    since: { since_sha: A, source: 'story', read: [] },
  });
  builds.claim(r.id, 'repo-acme-widgets', { start: true });
  assert.equal(
    builds.request({ repo: 'acme/widgets', number: 7, mode: 'update', base_sha: A, retell: true })
      .retell,
    undefined,
  );
  assert.equal(
    buildText({ repo: 'acme/widgets', number: 7, url: 'u' }),
    'Build a story for acme/widgets#7: u',
  );
});

test("the stories carry a chapter's since range through to the panel", async () => {
  const home = tmp('home');
  const dir = story(home, B);
  const plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  plan.chapters.unshift({
    key: 'since-aaaaaaa-bbbbbbb',
    title: 'Since you read it: 2 new commits',
    since: { from: A, to: B, commits: 2 },
    files: ['src/b.js'],
  });
  plan.chapters.push({
    title: 'Chapter 3: Bad range',
    since: { from: 'nope', to: B },
    files: ['README.md'],
  });
  writeJson(path.join(dir, 'chapters.json'), plan);
  const b = await startBridge({ home });
  try {
    const s = (await b.call('GET', '/api/stories/acme-widgets-7')).body;
    assert.deepEqual(s.chapters[0].since, { from: A, to: B, commits: 2 });
    assert.equal(s.chapters[0].key, 'since-aaaaaaa-bbbbbbb');
    assert.equal(s.chapters[1].since, undefined);
    assert.equal(s.chapters[3].since, undefined, 'a range that is not two commits is dropped');
  } finally {
    await b.close();
  }
});

test('the out-of-date tag offers Update (new commits) and Re-tell from scratch', () => {
  const pr = { repo: 'acme/widgets', number: 7 };
  const t = tagFor({ state: 'ready', stale: true, story_head: A, current_head: B }, pr);
  assert.equal(t.alt.act, 'retell');
  const html = tagHtml(t);
  assert.match(
    html,
    /^<button class="b stale" data-act="update"[^>]*>Story out of date · Update<\/button><button class="alt" data-act="retell"/,
  );
  assert.match(t.title, /^Update \(new commits\)/);
  assert.match(t.alt.title, /^Re-tell from scratch/);
  assert.equal(requestFor(t, pr).retell, undefined);
  assert.deepEqual(
    [requestFor(t, pr, { retell: true }).mode, requestFor(t, pr, { retell: true }).retell],
    ['update', true],
  );
  assert.equal(
    requestFor(tagFor({ state: 'none' }, pr), pr, { retell: true }).retell,
    undefined,
    'only an update can be a re-tell',
  );
});

test('"Since you read it" chapters finish their files and are not numbered', async () => {
  const { finishedInOf, chapterNumbers } = await import('../src/js/shared/overlay.js');
  const chapters = [
    {
      title: 'Since you read it: 1 new commit',
      since: { from: B, to: 'c'.repeat(40) },
      files: [{ rel: 'src/a.js' }],
    },
    {
      title: 'Since you read it: 2 new commits',
      since: { from: A, to: B },
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
  const { rangeOfPath, rangeStepOf, rangeUrl } = await import('../src/js/shared/overlay.js');
  const chapters = [
    { title: 'Since you read it', since: { from: A, to: B } },
    { title: 'Chapter 1: Start' },
  ];
  assert.deepEqual(rangeOfPath(`/acme/widgets/pull/7/files/${A}..${B}`), { from: A, to: B });
  assert.deepEqual(rangeOfPath('/acme/widgets/pull/7/changes/aaaaaaa..bbbbbbb/'), {
    from: 'aaaaaaa',
    to: 'bbbbbbb',
  });
  for (const p of [
    '/acme/widgets/pull/7/files',
    '/acme/widgets/pull/7/changes',
    `/acme/widgets/pull/7/commits/${A}`,
  ]) {
    assert.equal(rangeOfPath(p), null, p);
  }
  assert.equal(
    rangeStepOf(chapters, '/acme/widgets/pull/7/files/aaaaaaa..bbbbbbb'),
    1,
    'short SHAs match the full ones',
  );
  assert.equal(rangeStepOf(chapters, `/acme/widgets/pull/7/files/${B}..${A}`), null);
  assert.equal(rangeStepOf(chapters, '/acme/widgets/pull/7/files'), null);
  assert.equal(
    rangeUrl('https://github.com/acme/widgets/pull/7', { from: A, to: B }),
    `https://github.com/acme/widgets/pull/7/files/${A}..${B}`,
  );
  assert.equal(rangeUrl(null, { from: A, to: B }), null, 'a local story has no GitHub link');
});

test('the PR-list tag says how much of the story he has read', () => {
  const pr = { repo: 'acme/widgets', number: 7 };
  const href = 'https://github.com/acme/widgets/pull/7/changes';
  const t = (r) => tagFor({ state: 'ready', story_head: A, ...r }, pr);
  assert.deepEqual(
    [t({ reads: { read: 0, total: 5, next: 1 } }).label, t({}).label],
    ['Story', 'Story'],
    'unread',
  );
  const part = t({ reads: { read: 2, total: 5, next: 3 } });
  assert.deepEqual(
    [part.kind, part.label, part.href],
    ['link', 'Story · 2 of 5 read', `${href}#dsm-step-3`],
    'partly read: to the first unread chapter',
  );
  const all = t({ reads: { read: 5, total: 5, next: null } });
  assert.deepEqual([all.kind, all.label, all.cls, all.href], ['link', 'Read', 'read', href]);
  const moved = t({
    reads: { read: 5, total: 5, next: null },
    stale: true,
    current_head: B,
    newer: 3,
  });
  assert.deepEqual(
    [moved.kind, moved.act, moved.label, moved.base, moved.alt.act],
    ['button', 'update', 'Read · 3 new commits · Update', A, 'retell'],
  );
  assert.equal(
    t({ reads: { read: 1, total: 5, next: 2 }, stale: true, newer: 1 }).label,
    '1 of 5 read · 1 new commit · Update',
  );
  assert.equal(
    t({ reads: { read: 0, total: 5, next: 1 }, stale: true }).label,
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
  for (const r of [part, all, moved]) {
    assert.equal((tagHtml(r).match(/<(a|button|span) class="b/g) || []).length, 1, 'one tag');
  }
});

test('status-many reports reads and, when the PR moved on, how many new commits', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  noteRead(home, 'pr-acme-widgets-7', 'start', { story_head: A });
  const b = await startBridge({ home });
  try {
    let r = (
      await b.call('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.deepEqual(r.reads, { read: 1, total: 3, next: 2 });
    assert.deepEqual([r.stale, r.newer], [true, 2], 'the fake PR is at B, two commits on');
    noteRead(home, 'pr-acme-widgets-7', 'finish', { story_head: A });
    noteRead(home, 'pr-acme-widgets-7', 'not in a chapter yet', { story_head: A });
    await new Promise((res) => setTimeout(res, 5100)); // status-many caches 5s
    r = (
      await b.call('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.equal(
      tagFor(r, { repo: 'acme/widgets', number: 7 }).label,
      'Read · 2 new commits · Update',
    );
  } finally {
    await b.close();
  }
});
