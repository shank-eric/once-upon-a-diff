import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.mjs';
import { clearFreshness } from '../bridge/lib/freshness.mjs';

process.env.DIFF_STORY_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh.mjs',
);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function story(home, head) {
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
    head_oid: head,
  });
}

test('a story told from an older head is stale, with the files and chapters changed since', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, A);
  const b = await startBridge({ home });
  try {
    const f = (await b.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(f.state, 'stale');
    assert.equal(f.newer, 2);
    assert.deepEqual(f.changed_files, ['src/b.js']);
    assert.deepEqual(f.chapters_touched, [2], 'src/b.js is only in chapter 2');
    const list = (
      await b.call('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.equal(list.stale, true, 'the PR-list badge says out of date');
  } finally {
    await b.close();
  }
});

test('a story told from the current head is up to date', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, B);
  const b = await startBridge({ home });
  try {
    const f = (await b.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(f.state, 'current');
    assert.equal(f.story_head, B);
  } finally {
    await b.close();
  }
});

test('an update request stays pending until the story moves off the old head', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, A);
  const b = await startBridge({ home });
  try {
    const r = await b.call('POST', '/api/builds', {
      repo: 'acme/widgets',
      number: 7,
      mode: 'update',
      base_sha: A,
    });
    assert.equal(r.body.request.mode, 'update');
    let st = (await b.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.state, 'ready');
    assert.equal(st.updating, true, 'the old story is still there, but an update is on its way');
    writeJson(path.join(home, 'acme-widgets-7', 'meta.json'), {
      kind: 'github',
      repo: 'acme/widgets',
      number: 7,
      head_oid: B,
    });
    st = (await b.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.updating, false);
    assert.equal(st.request.status, 'done');
  } finally {
    await b.close();
  }
});

test('a story updated in place says what the update brought in; one with a "Since you read it" chapter does not', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, B);
  const done = {
    id: 'b_1',
    repo: 'acme/widgets',
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    status: 'done',
    mode: 'update',
    base_sha: A,
    since_sha: A,
    done_at: '2026-10-21T19:20:01Z',
  };
  writeJson(path.join(home, 'builds.json'), { 'acme/widgets#7': done });
  const b = await startBridge({ home });
  try {
    let f = (await b.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(f.state, 'current');
    assert.deepEqual(
      [f.updated.from, f.updated.to, f.updated.newer, f.updated.retold],
      [A, B, 2, false],
    );
    assert.deepEqual(f.updated.changed_files, ['src/b.js']);
    assert.deepEqual(f.updated.chapters_touched, [2]);
    // the same update told as a "Since you read it" chapter: that chapter says it, so no note
    const dir = path.join(home, 'acme-widgets-7');
    const plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
    plan.chapters.unshift({
      key: 'since-a-b',
      title: 'Since you read it: 2 new commits',
      since: { from: A, to: B, commits: 2 },
      files: ['src/b.js'],
    });
    writeJson(path.join(dir, 'chapters.json'), plan);
    f = (await b.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(f.updated, null);
    // a first build (not an update) has nothing to say either
    writeJson(path.join(home, 'builds.json'), { 'acme/widgets#7': { ...done, mode: undefined } });
    plan.chapters.shift();
    writeJson(path.join(dir, 'chapters.json'), plan);
    f = (await b.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(f.updated, null);
  } finally {
    await b.close();
  }
});
