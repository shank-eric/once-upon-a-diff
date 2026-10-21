import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmp, githubStory, startBridge } from './helpers.mjs';
import { Builds, CLAIM_FRESH_MS } from '../bridge/inbox/builds.mjs';
import { beat } from '../bridge/listeners/listeners.mjs';
import { Inbox } from '../bridge/inbox/inbox.mjs';

const inboxLines = (home) =>
  readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

describe('build requests', () => {
  let bridge, home;
  before(async () => {
    home = tmp('home');
    bridge = await startBridge({ home });
  });
  after(() => bridge.close());

  test('a PR with no story is "none", then "queued" once asked, with one request however often it is asked', async () => {
    const statusPath = '/api/builds/status?repo=acme/widgets&number=7';
    assert.equal((await bridge.call('GET', statusPath)).body.state, 'none');
    const response = await bridge.call('POST', '/api/builds', {
      repo: 'acme/widgets',
      number: 7,
      url: 'https://evil.example/x',
      requested_at: '2026-10-20T21:40:00Z',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, 'queued', 'no session has claimed it yet');
    assert.equal(
      response.body.request.url,
      'https://github.com/acme/widgets/pull/7',
      'the URL is rebuilt from repo and number',
    );
    assert.equal(response.body.request.requested_at, '2026-10-20T21:40:00.000Z');
    const again = await bridge.call('POST', '/api/builds', { repo: 'acme/widgets', number: 7 });
    assert.equal(again.body.request.id, response.body.request.id);
    const status = await bridge.call('GET', statusPath);
    assert.equal(status.body.state, 'queued');
    assert.equal(status.body.request.requested_at, '2026-10-20T21:40:00.000Z');
    const reqs = inboxLines(home).filter((e) => e.type === 'build_request');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].id, response.body.request.id);
    assert.deepEqual(
      (await bridge.call('GET', '/api/builds')).body.pending.map((build) => build.id),
      [response.body.request.id],
    );
  });

  test('turns "ready" when the story turns up, and marks the request done', async () => {
    githubStory(path.join(home, 'acme-widgets-7'));
    const status = await bridge.call('GET', '/api/builds/status?repo=acme/widgets&number=7');
    assert.equal(status.body.state, 'ready');
    assert.equal(status.body.story, 'acme-widgets-7');
    assert.equal(status.body.request.status, 'done');
    assert.equal((await bridge.call('GET', '/api/builds')).body.pending.length, 0);
    assert.ok(
      inboxLines(home).some((e) => e.type === 'build_done' && e.story === 'acme-widgets-7'),
    );
  });

  test('refuses a bad repo or number', async () => {
    assert.equal(
      (await bridge.call('POST', '/api/builds', { repo: 'acme/widgets; rm -rf /', number: 7 }))
        .status,
      400,
    );
    assert.equal(
      (await bridge.call('POST', '/api/builds', { repo: 'acme/widgets', number: 'x' })).status,
      400,
    );
    assert.equal(
      (await bridge.call('POST', '/api/builds', { repo: '../../etc', number: 1 })).status,
      400,
    );
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
  const off = new Builds(home, new Inbox(home), {
    autoBuild: { enabled: false, command: ['node', '-e', 'process.exit(9)'] },
  });
  assert.equal(off.autoBuild, null);
  const out = path.join(home, 'ran.txt');
  // write then rename, so ran.txt never exists half-written (writeFileSync creates it empty first)
  const [outJson, tempJson] = [JSON.stringify(out), JSON.stringify(`${out}.tmp`)];
  const script = `const fs = require('fs'); fs.writeFileSync(${tempJson}, process.argv[1] + ' ' + process.env.DIFF_STORY_NUMBER); fs.renameSync(${tempJson}, ${outJson})`;
  const builds = new Builds(home, new Inbox(home), {
    autoBuild: { enabled: true, command: [process.execPath, '-e', script, '{url}; echo hi'] },
  });
  const build = builds.request({ repo: 'acme/widgets', number: 7 });
  for (let i = 0; i < 50 && !existsSync(out); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    readFileSync(out, 'utf8'),
    'https://github.com/acme/widgets/pull/7; echo hi 7',
    'the argument is passed as is, not run by a shell',
  );
  assert.ok(existsSync(path.join(home, 'builds', `${build.id}.log`)));
});

test('PR lists get ready / queued / building / none for many PRs in one call, and who is listening per repo', async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    await bridge.call('POST', '/api/builds', { repo: 'acme/gadgets', number: 3 });
    const five = (await bridge.call('POST', '/api/builds', { repo: 'acme/gadgets', number: 5 }))
      .body.request;
    new Builds(home, new Inbox(home)).claim(five.id, 'repo-acme-gadgets', { start: true });
    const prs = [
      { repo: 'ACME/widgets', number: 7 },
      { repo: 'acme/gadgets', number: 3 },
      { repo: 'acme/gadgets', number: 4 },
      { repo: 'acme/gadgets', number: 5 },
    ];
    const response = await bridge.call('POST', '/api/stories/status-many', { prs });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.results.map((result) => result.state),
      ['ready', 'queued', 'none', 'building'],
    );
    assert.deepEqual(
      Object.keys(response.body.listening),
      ['ACME/widgets', 'acme/gadgets'],
      'one listening check per repo',
    );
    assert.equal(response.body.listening['acme/gadgets'].ok, false);
    assert.equal(response.body.listening['acme/gadgets'].prompt, '/diff-story-listen acme/gadgets');
    beat(home, 'repo-acme-gadgets', 'waiting', { repo: 'acme/gadgets' });
    const listening = (await bridge.call('POST', '/api/stories/status-many', { prs })).body
      .listening;
    assert.equal(listening['acme/gadgets'].ok, true);
    assert.equal(listening['ACME/widgets'].ok, false, "a gadgets listener doesn't cover widgets");
    assert.equal(response.body.results[0].story, 'acme-widgets-7');
    assert.equal(
      (await bridge.call('POST', '/api/stories/status-many', { prs: 'nope' })).body.results.length,
      0,
    );
  } finally {
    await bridge.close();
  }
});

describe('diff-story wait hands over build requests, queued until claimed', () => {
  const BIN = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../bridge/bin/diff-story.mjs',
  );
  const cli = (home, args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [BIN, ...args],
        { env: { ...process.env, DIFF_STORY_HOME: home } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
      );
    });
  const wait = async (home, ...args) => {
    const result = await cli(home, ['wait', '--timeout', '1', '--json', ...args]);
    return {
      code: result.code,
      entries: result.stdout.trim() ? result.stdout.trim().split('\n').map(JSON.parse) : [],
    };
  };

  test('hands over requests asked before it started, once, claiming each so it shows Building', async () => {
    const home = tmp('home');
    const builds = new Builds(home, new Inbox(home));
    const widgetsOne = builds.request({ repo: 'acme/widgets', number: 1 });
    const widgetsTwo = builds.request({ repo: 'acme/widgets', number: 2 });
    const gadgets = builds.request({ repo: 'acme/gadgets', number: 3 });
    builds.done(widgetsTwo.id);
    assert.equal(builds.stateOf(builds.get('acme/widgets', 1)), 'queued');

    const first = await wait(home, '--consumer', 'fresh');
    assert.equal(first.code, 0);
    assert.deepEqual(
      first.entries.map((e) => e.id),
      [widgetsOne.id, gadgets.id],
      'pending ones, oldest first; the done one is skipped',
    );
    assert.equal(
      builds.stateOf(builds.get('acme/widgets', 1)),
      'building',
      'handed over = claimed',
    );
    assert.equal(builds.get('acme/widgets', 1).claimed_by, 'fresh');

    assert.equal((await wait(home, '--consumer', 'fresh')).code, 2, 'nothing new: it times out');
    assert.equal(
      (await wait(home, '--consumer', 'another')).code,
      2,
      'a claimed request is not handed to a second listener',
    );

    const e = builds.request({ repo: 'acme/widgets', number: 9 });
    assert.deepEqual(
      (await wait(home, '--consumer', 'fresh')).entries.map((entry) => entry.id),
      [e.id],
    );
  });

  test('a claim with no refresh goes back to queued and is handed out again; builds --start refreshes it', async () => {
    const home = tmp('home');
    const builds = new Builds(home, new Inbox(home));
    const request = builds.request({ repo: 'acme/widgets', number: 1 });
    await wait(home, '--consumer', 'one');
    const all = builds.all();
    const key = Object.keys(all)[0];
    all[key].claimed_at = new Date(Date.now() - CLAIM_FRESH_MS - 1000).toISOString();
    builds.save(all);
    assert.equal(
      builds.stateOf(builds.get('acme/widgets', 1)),
      'queued',
      'stale Building is Queued again',
    );
    assert.deepEqual(
      (await wait(home, '--consumer', 'two')).entries.map((entry) => entry.id),
      [request.id],
    );

    const started = await cli(home, ['builds', '--start', request.id]);
    assert.equal(started.code, 0);
    assert.match(started.stdout, /building/);
    assert.ok(builds.get('acme/widgets', 1).started_at);
    assert.notEqual((await cli(home, ['builds', '--start', 'b_nope'])).code, 0);
    assert.match((await cli(home, ['builds'])).stdout, /\tbuilding\tacme\/widgets#1\t/);
  });

  test('--repo takes questions and build requests for that repo only, and beats for that repo', async () => {
    const home = tmp('home');
    const inbox = new Inbox(home);
    const builds = new Builds(home, inbox);
    const mine = builds.request({ repo: 'octo-org/api-server', number: 1 });
    builds.request({ repo: 'octo-org/web-app', number: 2 });
    const result = await wait(home, '--repo', 'octo-org/api-server');
    assert.deepEqual(
      result.entries.map((entry) => entry.id),
      [mine.id],
      "repo names match whatever their case; other repos' requests stay queued",
    );
    assert.equal(builds.stateOf(builds.get('octo-org/web-app', 2)), 'queued');
    const beat = JSON.parse(
      readFileSync(path.join(home, 'listeners', 'repo-octo-org-api-server.json'), 'utf8'),
    );
    assert.equal(beat.repo, 'octo-org/api-server');

    // questions carry their story's repo; a wait's cursor starts from now, so ask after it starts
    const waiting = wait(home, '--repo', 'octo-org/api-server', '--type', 'question');
    await new Promise((res) => setTimeout(res, 300));
    inbox.append({
      type: 'question',
      id: 'q_other',
      story: 's2',
      repo: 'octo-org/web-app',
      text: 'not mine',
    });
    inbox.append({
      type: 'question',
      id: 'q_mine',
      story: 's1',
      repo: 'octo-org/api-server',
      text: 'mine',
    });
    assert.deepEqual(
      (await waiting).entries.map((entry) => entry.id),
      ['q_mine'],
    );
    assert.equal((await cli(home, ['wait', '--repo', 'not a repo'])).code, 1);
  });
});
