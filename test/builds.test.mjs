import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { tmp, githubStory, startBridge } from './helpers.mjs';
import { Builds } from '../bridge/lib/builds.mjs';
import { Inbox } from '../bridge/lib/inbox.mjs';

const inboxLines = home => readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

describe('build requests', () => {
  let b, home;
  before(async () => {
    home = tmp('home');
    b = await startBridge({ home });
  });
  after(() => b.close());

  test('a PR with no story is "none", then "building" once asked, with one request however often it is asked', async () => {
    const q = '/api/builds/status?repo=acme/widgets&number=7';
    assert.equal((await b.call('GET', q)).body.state, 'none');
    const r = await b.call('POST', '/api/builds', { repo: 'acme/widgets', number: 7, url: 'https://evil.example/x', requested_at: '2026-10-20T21:40:00Z' });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'building');
    assert.equal(r.body.request.url, 'https://github.com/acme/widgets/pull/7', 'the URL is rebuilt from repo and number');
    assert.equal(r.body.request.requested_at, '2026-10-20T21:40:00.000Z');
    const again = await b.call('POST', '/api/builds', { repo: 'acme/widgets', number: 7 });
    assert.equal(again.body.request.id, r.body.request.id);
    const st = await b.call('GET', q);
    assert.equal(st.body.state, 'building');
    assert.equal(st.body.request.requested_at, '2026-10-20T21:40:00.000Z');
    const reqs = inboxLines(home).filter(e => e.type === 'build_request');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].id, r.body.request.id);
    assert.deepEqual((await b.call('GET', '/api/builds')).body.pending.map(x => x.id), [r.body.request.id]);
  });

  test('turns "ready" when the story turns up, and marks the request done', async () => {
    githubStory(path.join(home, 'acme-widgets-7'));
    const st = await b.call('GET', '/api/builds/status?repo=acme/widgets&number=7');
    assert.equal(st.body.state, 'ready');
    assert.equal(st.body.story, 'acme-widgets-7');
    assert.equal(st.body.request.status, 'done');
    assert.equal((await b.call('GET', '/api/builds')).body.pending.length, 0);
    assert.ok(inboxLines(home).some(e => e.type === 'build_done' && e.story === 'acme-widgets-7'));
  });

  test('refuses a bad repo or number', async () => {
    assert.equal((await b.call('POST', '/api/builds', { repo: 'acme/widgets; rm -rf /', number: 7 })).status, 400);
    assert.equal((await b.call('POST', '/api/builds', { repo: 'acme/widgets', number: 'x' })).status, 400);
    assert.equal((await b.call('POST', '/api/builds', { repo: '../../etc', number: 1 })).status, 400);
  });
});

test('done by id or by repo#number; failed requests show as failed', () => {
  const home = tmp('home');
  const builds = new Builds(home, new Inbox(home));
  const one = builds.request({ repo: 'acme/a', number: 1 });
  builds.request({ repo: 'acme/b', number: 2 });
  assert.equal(builds.done(one.id).status, 'done');
  assert.equal(builds.done('ACME/b#2', { failed: true, note: 'no checkout' }).status, 'failed');
  assert.equal(builds.pending().length, 0);
  assert.equal(builds.done('nope'), null);
});

test('autoBuild is off unless enabled, and runs an argv command (no shell) with the PR filled in', async () => {
  const home = tmp('home');
  const off = new Builds(home, new Inbox(home), { autoBuild: { enabled: false, command: ['node', '-e', 'process.exit(9)'] } });
  assert.equal(off.autoBuild, null);
  const out = path.join(home, 'ran.txt');
  const builds = new Builds(home, new Inbox(home), {
    autoBuild: { enabled: true, command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv[1] + ' ' + process.env.DIFF_STORY_NUMBER)`, '{url}; echo hi'] },
  });
  const b = builds.request({ repo: 'acme/widgets', number: 7 });
  for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(readFileSync(out, 'utf8'), 'https://github.com/acme/widgets/pull/7; echo hi 7', 'the argument is passed as is, not run by a shell');
  assert.ok(existsSync(path.join(home, 'builds', `${b.id}.log`)));
});
