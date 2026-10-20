import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.mjs';
import { clearFreshness } from '../bridge/lib/freshness.mjs';

process.env.DIFF_STORY_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function story(home, head) {
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  writeJson(path.join(dir, 'meta.json'), { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: head });
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
    const list = (await b.call('POST', '/api/stories/status-many', { prs: [{ repo: 'acme/widgets', number: 7 }] })).body.results[0];
    assert.equal(list.stale, true, 'the PR-list badge says out of date');
  } finally { await b.close(); }
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
  } finally { await b.close(); }
});

test('an update request stays pending until the story moves off the old head', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home, A);
  const b = await startBridge({ home });
  try {
    const r = await b.call('POST', '/api/builds', { repo: 'acme/widgets', number: 7, mode: 'update', base_sha: A });
    assert.equal(r.body.request.mode, 'update');
    let st = (await b.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.state, 'ready');
    assert.equal(st.updating, true, 'the old story is still there, but an update is on its way');
    writeJson(path.join(home, 'acme-widgets-7', 'meta.json'), { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: B });
    st = (await b.call('GET', '/api/builds/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.updating, false);
    assert.equal(st.request.status, 'done');
  } finally { await b.close(); }
});
