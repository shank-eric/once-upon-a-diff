import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson, startBridge, runCli, TOKEN, type TestBridge } from './helpers.ts';
import { inboxKey, pageKey } from '../src/server/page-key.ts';

/** Every bridge a test started, closed at the end so a failed test can't keep the process alive. */
const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

test('the inbox page’s key reaches the inbox routes and nothing else', async () => {
  const bridge = await startBridge({ home: tmp('inbox-home') });
  open.push(bridge);
  const withKey = (key: string, method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${key}` });

  const key = inboxKey(TOKEN);
  const listed = await withKey(key, 'GET', '/api/inbox');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { repos: [], stories: [], local_stories: [] });
  assert.equal((await withKey(key, 'GET', '/api/inbox?repo=acme/widgets')).status, 200);
  // Mark reviewed and Open story are the inbox's too: they get as far as finding no such story
  for (const route of ['/api/inbox/reviewed', '/api/inbox/open']) {
    assert.equal((await withKey(key, 'POST', route, { story: 'some-story' })).status, 404, route);
  }
  // the link, the rest of the API and any story are the token's alone
  for (const [method, route, body] of [
    ['GET', '/api/inbox/link', undefined],
    ['GET', '/api/stories', undefined],
    ['GET', '/api/prefs', undefined],
    ['POST', '/api/builds', {}],
    ['GET', '/api/stories/some-story', undefined],
  ] as const) {
    assert.equal((await withKey(key, method, route, body)).status, 403, `${method} ${route}`);
  }
  // and a story's key doesn't open the inbox, nor the inbox key a story
  assert.equal((await withKey(pageKey(TOKEN, 'some-story'), 'GET', '/api/inbox')).status, 403);
  assert.equal((await withKey(`${key}x`, 'GET', '/api/inbox')).status, 403);
  // the link the token asks for carries the key in the fragment, and the page itself carries none
  const link = await bridge.call<{ url: string }>('GET', '/api/inbox/link?repo=acme/widgets');
  assert.equal(link.body.url, `${bridge.base}/inbox/#key=${key}&repo=acme%2Fwidgets`);
  const page = await fetch(`${bridge.base}/inbox/`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(key));
  await bridge.close();
});

test('`once-upon review` prints the inbox link', async () => {
  const home = tmp('inbox-cli');
  writeJson(path.join(home, 'config.json'), { port: 48999, token: TOKEN });
  const ran = await runCli(home, ['review', '--no-open']);
  assert.equal(ran.code, 0);
  // on the proxy's name by default, on the bridge's own address with --local
  assert.equal(ran.stdout.trim(), `https://once-upon.test/inbox/#key=${inboxKey(TOKEN)}`);
  const local = await runCli(home, ['review', '--no-open', '--local']);
  assert.equal(local.stdout.trim(), `http://127.0.0.1:48999/inbox/#key=${inboxKey(TOKEN)}`);
  const repo = await runCli(home, ['review', '--no-open', '--local', '--repo', 'acme/widgets']);
  assert.equal(
    repo.stdout.trim(),
    `http://127.0.0.1:48999/inbox/#key=${inboxKey(TOKEN)}&repo=acme%2Fwidgets`,
  );
  const bad = await runCli(home, ['review', '--no-open', '--repo', 'nope']);
  assert.notEqual(bad.code, 0);
});
