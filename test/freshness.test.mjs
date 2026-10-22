import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.mjs';
import { clearFreshness } from '../bridge/github/freshness.mjs';

process.env.DIFF_STORY_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh.mjs',
);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function story(home, head) {
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir, { meta: { head_oid: head } });
}

test('a story told from an older head is stale, with the files and chapters changed since', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, SHA_A);
  const bridge = await startBridge({ home });
  try {
    const fresh = (await bridge.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(fresh.state, 'stale');
    assert.equal(fresh.newer, 2);
    assert.deepEqual(fresh.changed_files, ['src/b.js']);
    assert.deepEqual(fresh.chapters_touched, [2], 'src/b.js is only in chapter 2');
    const list = (
      await bridge.call('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.equal(list.stale, true, 'the PR-list badge says out of date');
  } finally {
    await bridge.close();
  }
});

test('a story told from the current head is up to date', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, SHA_B);
  const bridge = await startBridge({ home });
  try {
    const fresh = (await bridge.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(fresh.state, 'current');
    assert.equal(fresh.story_head, SHA_B);
  } finally {
    await bridge.close();
  }
});

test('an update request stays pending until the story moves off the old head', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, SHA_A);
  const bridge = await startBridge({ home });
  try {
    const response = await bridge.call('POST', '/api/builds', {
      repo: 'acme/widgets',
      number: 7,
      mode: 'update',
      base_sha: SHA_A,
    });
    assert.equal(response.body.request.mode, 'update');
    let status = (await bridge.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(status.state, 'ready');
    assert.equal(
      status.updating,
      true,
      'the old story is still there, but an update is on its way',
    );
    story(home, SHA_B);
    status = (await bridge.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(status.updating, false);
    assert.equal(status.request.status, 'done');
  } finally {
    await bridge.close();
  }
});

test('a story updated in place says what the update brought in; one with a "Since you read it" chapter does not', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, SHA_B);
  const done = {
    id: 'b_1',
    repo: 'acme/widgets',
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    status: 'done',
    mode: 'update',
    base_sha: SHA_A,
    since_sha: SHA_A,
    done_at: '2026-10-21T19:20:01Z',
  };
  writeJson(path.join(home, 'builds.json'), { 'acme/widgets#7': done });
  const bridge = await startBridge({ home });
  try {
    let fresh = (await bridge.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(fresh.state, 'current');
    assert.deepEqual(
      [fresh.updated.from, fresh.updated.to, fresh.updated.newer, fresh.updated.retold],
      [SHA_A, SHA_B, 2, false],
    );
    assert.deepEqual(fresh.updated.changed_files, ['src/b.js']);
    assert.deepEqual(fresh.updated.chapters_touched, [2]);
    // the same update told as a "Since you read it" chapter: that chapter says it, so no note
    const dir = path.join(home, 'acme-widgets-7');
    const plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
    plan.chapters.unshift({
      key: 'since-a-b',
      title: 'Since you read it: 2 new commits',
      since: { from: SHA_A, to: SHA_B, commits: 2 },
      files: ['src/b.js'],
    });
    writeJson(path.join(dir, 'chapters.json'), plan);
    fresh = (await bridge.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(fresh.updated, null);
    // a first build (not an update) has nothing to say either
    writeJson(path.join(home, 'builds.json'), { 'acme/widgets#7': { ...done, mode: undefined } });
    plan.chapters.shift();
    writeJson(path.join(dir, 'chapters.json'), plan);
    fresh = (await bridge.call('GET', '/api/stories/acme-widgets-7/freshness')).body;
    assert.equal(fresh.updated, null);
  } finally {
    await bridge.close();
  }
});
