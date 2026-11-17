import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  tmp,
  git,
  writeJson,
  startBridge,
  TOKEN,
  storyList,
  markReviewed,
  type TestBridge,
} from './helpers.ts';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { stopRequested } from '@once-upon-a-diff/core/features/listeners/auto-stop';
import { boardKey, pageKey, viewKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import {
  type BoardCard,
  type BoardData,
  type StoryRequest,
} from '@once-upon-a-diff/contracts/types';
import {
  checkoutOf,
  fakeIt2,
  fakeLarmor,
  fullId,
  liveChild,
  localStory,
  pause,
  prStory,
  procStartOf,
  registry,
} from '@once-upon-a-diff/state/test/board-fixtures';

// 3:00 PM EDT

const open: TestBridge[] = [];

after(() => Promise.all(open.map((bridge) => bridge.close())));

/** A bridge whose settings point at an empty registry folder, so the real ~/.claude is never read. */
async function boardBridge() {
  const home = tmp('board-bridge');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  return { home, bridge };
}

/** A request with a Host the test chooses (fetch won't let a script set it): status, body text and headers. */
function rawRequest(
  base: string,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: route,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode as number, text, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the board page and its key: the board routes only, the other pages’ links, nothing else', async () => {
  const { bridge } = await boardBridge();
  const withKey = (key: string, route: string) =>
    bridge.call('GET', route, undefined, { Authorization: `Bearer ${key}` });
  const key = boardKey(TOKEN);
  const answer = await withKey(key, '/api/board');
  assert.equal(answer.status, 200);
  const data = answer.body as BoardData;
  assert.equal(data.status_source, 'registry');
  assert.equal(data.lanes[0].cards[0].column, 'thinking', 'a busy session with no run open');
  assert.equal((await bridge.call('GET', '/api/board')).status, 200, 'the token reaches it too');

  for (const route of ['/api/board/link', '/api/stories', '/api/prefs']) {
    assert.equal((await withKey(key, route)).status, 403, route);
  }
  // the board's key is handed out to the bridge's token alone (the extension, the CLI), and to no other key
  const withToken = await bridge.call<{ url: string }>('GET', '/api/board/link');
  assert.equal(withToken.body.url, `${bridge.base}/board/#key=${key}`);
  for (const route of ['/api/board/link', '/api/board/link?public=1']) {
    const got = await withKey(pageKey(TOKEN, 'x'), route);
    assert.ok(!got.text.includes(key), `${route} leaks no board key`);
  }
  for (const [method, route] of [
    ['POST', '/api/board/type'],
    ['POST', '/api/board/focus'],
    ['POST', '/api/board/voice/pause'],
    ['POST', '/api/board/voice/phone'],
    ['POST', '/api/board/voice/phone/bridge-stop'],
    ['POST', '/api/board/stop-listening'],
    ['POST', '/api/board/agent/finish'],
  ] as const) {
    assert.equal(
      (await bridge.call(method, route, {}, { Authorization: `Bearer ${pageKey(TOKEN, 'x')}` }))
        .status,
      403,
      `${route} is the board's`,
    );
  }
  assert.equal((await withKey(pageKey(TOKEN, 'x'), '/api/board')).status, 403);
  assert.equal((await withKey(`${key}x`, '/api/board')).status, 403);
  assert.equal(
    (await bridge.call('POST', '/api/board', {}, { Authorization: `Bearer ${key}` })).status,
    403,
  );
  // the page carries no key
  const page = await fetch(`${bridge.base}/board/`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(key));
  assert.equal((await fetch(`${bridge.base}/assets/board.ts`)).status, 200);
});

test('the pulse says when a session has a request for the story, building or queued, so the panel can drop Update', async () => {
  const home = tmp('board-pulse');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const pulse = async () =>
    (
      await bridge.call<{ request: StoryRequest | null }>(
        'GET',
        '/api/stories/acme-widgets-7/pulse',
      )
    ).body.request;
  const ask = (extra: Record<string, unknown>) =>
    new Builds(home).save({
      'acme/widgets#7': {
        id: 'b1',
        repo: 'acme/widgets',
        number: 7,
        url: null,
        requested_at: '2026-10-26T18:00:00Z',
        status: 'pending',
        ...extra,
      },
    });
  assert.equal(await pulse(), null);
  ask({ mode: 'update', base_sha: 'abc' });
  assert.deepEqual(await pulse(), {
    kind: 'update',
    state: 'queued',
    requested_at: '2026-10-26T18:00:00Z',
    claimed_by: null,
    claimed_at: null,
  });
  const claimed = new Date().toISOString();
  ask({
    mode: 'rebuild',
    story: 'acme-widgets-7',
    claimed_by: 'session-a',
    claimed_at: claimed,
  });
  assert.deepEqual(await pulse(), {
    kind: 'rebuild',
    state: 'building',
    requested_at: '2026-10-26T18:00:00Z',
    claimed_by: 'session-a',
    claimed_at: claimed,
  });
  ask({ claimed_by: 'session-a', claimed_at: claimed });
  assert.equal((await pulse())?.kind, 'build');
  ask({ status: 'done', done_at: claimed });
  assert.equal(await pulse(), null, 'finished: Update can come back');
  // a fix request a session has taken counts too, and a taken one wins over a queued one
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-7',
      repo: 'acme/widgets',
      kind: 'github',
      notes: [],
      requested_at: '2026-10-26T18:05:00Z',
      status: 'pending',
      claimed_by: 'session-b',
      claimed_at: claimed,
    },
  });
  assert.deepEqual(
    [(await pulse())?.kind, (await pulse())?.state, (await pulse())?.claimed_by],
    ['fix', 'building', 'session-b'],
  );
});

test('a request belongs to its own story: PR #12’s fix is not #1’s, and another story’s rebuild is not this one’s', async () => {
  const home = tmp('board-pulse-scope');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1, 'feat/one');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/seven');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const pulse = async (id: string) =>
    (await bridge.call<{ request: StoryRequest | null }>('GET', `/api/stories/${id}/pulse`)).body
      .request;
  const fix = (number: number, url: string) => ({
    id: `f${number}`,
    story: `acme-widgets-${number}`,
    repo: 'acme/widgets',
    url,
    kind: 'github',
    notes: [],
    requested_at: '2026-10-26T18:05:00Z',
    status: 'pending',
  });
  writeJson(path.join(home, 'fixes.json'), {
    f12: fix(12, 'https://github.com/acme/widgets/pull/12'),
    f10: fix(10, 'https://github.com/acme/widgets/pull/10/files'),
  });
  assert.equal(await pulse('acme-widgets-1'), null, '#12 and #10 are not #1');
  writeJson(path.join(home, 'fixes.json'), {
    f1: { ...fix(7, 'https://github.com/acme/widgets/pull/1/files?w=1'), story: 'other-story' },
  });
  assert.equal((await pulse('acme-widgets-1'))?.kind, 'fix', 'the PR’s own number still matches');

  // a rebuild asked for another story of the PR doesn't show on this one
  new Builds(home).save({
    'acme/widgets#7': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 7,
      url: null,
      requested_at: '2026-10-26T18:00:00Z',
      status: 'pending',
      mode: 'rebuild',
      story: 'acme-widgets-7-older',
    },
  });
  assert.equal(await pulse('acme-widgets-7'), null);
  new Builds(home).save({
    'acme/widgets#7': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 7,
      url: null,
      requested_at: '2026-10-26T18:00:00Z',
      status: 'pending',
      mode: 'rebuild',
      story: 'acme-widgets-7',
    },
  });
  assert.equal((await pulse('acme-widgets-7'))?.kind, 'rebuild');
});

test('POST /api/board/focus takes the board key, a live session id and nothing else', async () => {
  const home = tmp('board-focus-route');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, '#!/bin/sh\nexit 0\n');
  chmodSync(it2, 0o755);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (key: string, body: unknown) =>
    bridge.call('POST', '/api/board/focus', body, { Authorization: `Bearer ${key}` });
  const key = boardKey(TOKEN);
  assert.equal((await post(key, {})).status, 400);
  assert.equal((await post(key, { session: '../etc' })).status, 400);
  assert.equal((await post(key, { session: 'not-a-live-session' })).status, 404);
  // a live session whose process has no terminal (this test's) has no tab to raise
  assert.equal((await post(key, { session: fullId(process.pid) })).status, 409);
  // another page's key doesn't reach it
  assert.equal((await post(pageKey(TOKEN, 'x'), { session: fullId(process.pid) })).status, 403);
  // and with iTerm turned off in the settings there is nothing to do
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  assert.equal((await post(key, { session: fullId(process.pid) })).status, 409);
});

test('the bridge answers a proxy’s allowed host names, keeps the key in an HttpOnly cookie, and nothing else gets in', async () => {
  const { bridge } = await boardBridge();
  const name = 'once-upon.test';
  const origin = `https://${name}`;
  const asHost = (headers: Record<string, string> = {}) => ({ Host: name, ...headers });
  const board = boardKey(TOKEN);

  // names that are not allowed are refused (DNS rebinding), exactly: no suffix or prefix tricks
  for (const bad of [
    'evil.test',
    'once-upon.test.evil.com',
    'xonce-upon.test',
    'once-upon.test:4823',
  ]) {
    assert.equal((await rawRequest(bridge.base, 'GET', '/board/', { Host: bad })).status, 421, bad);
  }
  assert.equal((await rawRequest(bridge.base, 'GET', '/board/', asHost())).status, 200);
  assert.equal(
    (await rawRequest(bridge.base, 'GET', '/board/', { Host: 'once-upon.fidev.net' })).status,
    200,
  );
  assert.equal(
    (await rawRequest(bridge.base, 'GET', '/board/', asHost({ Origin: 'https://evil.test' })))
      .status,
    403,
  );

  // no cookie, no key: refused
  assert.equal((await rawRequest(bridge.base, 'GET', '/api/board', asHost())).status, 401);

  // the page hands over its key: only the board's, only from that host's own page
  const start = (key: string, headers: Record<string, string>) =>
    rawRequest(bridge.base, 'POST', '/auth/session', headers, { key });
  assert.equal((await start(board, asHost())).status, 403, 'no Origin');
  assert.equal((await start(board, asHost({ Origin: 'https://evil.test' }))).status, 403);
  assert.equal(
    (await start(TOKEN, asHost({ Origin: origin }))).status,
    403,
    'the bridge token is not a page key',
  );
  assert.equal(
    (await start(pageKey(TOKEN, 'x'), asHost({ Origin: origin }))).status,
    403,
    'nor is a story’s',
  );
  assert.equal((await start('page.wrong', asHost({ Origin: origin }))).status, 403);
  const set = await start(board, asHost({ Origin: origin }));
  assert.equal(set.status, 200);
  const cookie = [set.headers['set-cookie']].flat()[0] as string;
  assert.match(cookie, /^__Host-ou-board=page\./);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
    assert.ok(cookie.includes(attribute), attribute);
  }
  assert.ok(!cookie.includes('Domain'), 'the cookie belongs to the host alone');
  // plain http is let in, but the browser would refuse the Secure cookie there, so none is offered
  const plain = await start(board, asHost({ Origin: `http://${name}` }));
  assert.equal(plain.status, 200);
  assert.deepEqual(JSON.parse(plain.text), { cookie: false });
  assert.equal(plain.headers['set-cookie'], undefined);
  const boardCookie = cookie.split(';')[0];

  // on the bridge's own address there is no cookie to set
  const direct = await rawRequest(
    bridge.base,
    'POST',
    '/auth/session',
    { Origin: bridge.base },
    { key: board },
  );
  assert.deepEqual(JSON.parse(direct.text), { cookie: false });
  assert.equal(direct.headers['set-cookie'], undefined);

  // with the cookie the board loads, and the cookie reaches only the board's routes
  const withCookie = (route: string, cookies: string, extra: Record<string, string> = {}) =>
    rawRequest(bridge.base, 'GET', route, asHost({ Cookie: cookies, ...extra }));
  assert.equal((await withCookie('/api/board', boardCookie)).status, 200);
  assert.equal((await withCookie('/api/stories', boardCookie)).status, 403);
  assert.equal((await withCookie('/api/board', 'x=1; __Host-ou-board=page.nope')).status, 403);

  // a write by cookie needs an allowed Origin; the header key works as before
  const post = (headers: Record<string, string>) =>
    rawRequest(bridge.base, 'POST', '/api/board/focus', asHost(headers), {});
  assert.equal((await post({ Cookie: boardCookie })).status, 403);
  assert.equal((await post({ Cookie: boardCookie, Origin: 'https://evil.test' })).status, 403);
  assert.equal(
    (await post({ Cookie: boardCookie, Origin: origin })).status,
    400,
    'in: it reaches the route',
  );
  assert.equal(
    (await post({ Authorization: `Bearer ${board}` })).status,
    400,
    'a header key needs no Origin',
  );
});

test('allowed_hosts in config.json decides the names, and only those', async () => {
  const { home, bridge } = await boardBridge();
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: path.join(home, 'none'),
    allowed_hosts: ['board.example.test', 'bad host', 'UPPER.test'],
  });
  const get = (host: string) => rawRequest(bridge.base, 'GET', '/board/', { Host: host });
  assert.equal((await get('board.example.test')).status, 200);
  assert.equal((await get('upper.test')).status, 200, 'names compare in lower case');
  assert.equal(
    (await get('once-upon.test')).status,
    421,
    'the defaults are replaced, not added to',
  );
});

test('the extension asks the bridge for a fresh page link, on the proxy’s address with ?public=1', async () => {
  const { home, bridge } = await boardBridge();
  const link = async (route: string) => (await bridge.call<{ url: string }>('GET', route)).body.url;
  // as the page's own tab would: the bridge's address
  assert.equal(await link('/api/board/link'), `${bridge.base}/board/#key=${boardKey(TOKEN)}`);
  // the extension's ask: the proxy's name, which sets the cookie in its browser
  assert.equal(
    await link('/api/board/link?public=1'),
    `https://once-upon.test/board/#key=${boardKey(TOKEN)}`,
  );
  // and when no proxy name is set, the bridge's own address
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: path.join(home, 'none'),
    public_host: 'none',
  });
  assert.equal(
    await link('/api/board/link?public=1'),
    `${bridge.base}/board/#key=${boardKey(TOKEN)}`,
  );
});

test('a public host that does not resolve to this machine is not offered (a setup with no proxy gets 127.0.0.1)', async () => {
  const saved = process.env.ONCE_UPON_NO_HOST_CHECK;
  delete process.env.ONCE_UPON_NO_HOST_CHECK;
  try {
    const { home, bridge } = await boardBridge();
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: path.join(home, 'none'),
      allowed_hosts: ['nowhere.invalid'],
    });
    const { body } = await bridge.call<{ url: string }>('GET', '/api/board/link?public=1');
    assert.equal(body.url, `${bridge.base}/board/#key=${boardKey(TOKEN)}`);
    // a name set in config.json is used as set, resolvable or not
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: path.join(home, 'none'),
      allowed_hosts: ['nowhere.invalid'],
      public_host: 'nowhere.invalid',
    });
    const set = await bridge.call<{ url: string }>('GET', '/api/board/link?public=1');
    assert.equal(set.body.url, `https://nowhere.invalid/board/#key=${boardKey(TOKEN)}`);
    const { resolvesHere } = await import('@once-upon-a-diff/state/records/page-links/address');
    assert.equal(await resolvesHere('localhost'), true);
    assert.equal(await resolvesHere('nowhere.invalid'), false);
  } finally {
    if (saved !== undefined) {
      process.env.ONCE_UPON_NO_HOST_CHECK = saved;
    }
  }
});

test('POST /api/board/voice/pause asks voice_ctl to pause and resume, only with voice on and the board key', async () => {
  const home = tmp('board-voice-pause');
  const voiceDir = tmp('board-voice');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', '/api/board/voice/pause', body, { Authorization: `Bearer ${key}` });
  const paused = path.join(voiceDir, 'paused');
  assert.equal((await post({ paused: true })).status, 400, 'board_larmor_dir is not set');
  writeJson(path.join(home, 'config.json'), { board_larmor_dir: fakeLarmor(voiceDir) });
  assert.equal((await post({})).status, 400, 'paused is needed');
  assert.equal((await post({ paused: 'yes' })).status, 400);
  // voice is off: nothing to pause
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  const refused = await post({ paused: true });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /Voice isn.t on/, 'Larmor’s own reason');
  assert.equal(existsSync(paused), false);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  assert.equal((await post({ paused: true })).status, 200);
  assert.equal(existsSync(paused), true);
  assert.equal((await post({ paused: true })).status, 200, 'pausing twice is fine');
  assert.equal((await post({ paused: false })).status, 200);
  assert.equal(existsSync(paused), false);
  assert.equal((await post({ paused: false })).status, 200, 'resuming when not paused is fine');
  // resume works after voice ended too
  writeFileSync(paused, '');
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  assert.equal((await post({ paused: false })).status, 200);
  assert.equal(existsSync(paused), false);
  // another page's key doesn't reach it
  assert.equal((await post({ paused: true }, pageKey(TOKEN, 'x'))).status, 403);
});

test('Pause and Resume have their own guard: they work while a Start or a phone action runs, and refuse only another Pause or Resume', async () => {
  const home = tmp('board-voice-pause-guard');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor(voiceDir);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  writeJson(path.join(home, 'config.json'), {
    board_larmor_dir: larmor,
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, {
      Authorization: `Bearer ${boardKey(TOKEN)}`,
    });
  writeFileSync(path.join(larmor, 'slow'), ''); // every command but status takes 1 s
  const starting = post('start', {});
  await pause(300);
  const during = await post('pause', { paused: true });
  assert.equal(during.status, 200, during.text);
  assert.equal(existsSync(path.join(voiceDir, 'paused')), true);
  assert.equal((await starting).status, 200);
  // a second Pause or Resume while one runs is refused
  const first = post('pause', { paused: false });
  await pause(300);
  const second = await post('pause', { paused: true });
  assert.equal(second.status, 409);
  assert.match(second.text, /still working/);
  assert.equal((await first).status, 200);
});

test('POST /api/board/voice/phone and /phone/bridge-stop ask Larmor’s voice_ctl, voice on or not, with the board key', async () => {
  const home = tmp('board-voice-phone-post');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor(voiceDir);
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, { Authorization: `Bearer ${key}` });
  const calls = () =>
    existsSync(path.join(larmor, 'calls.log'))
      ? readFileSync(path.join(larmor, 'calls.log'), 'utf8')
      : '';
  assert.equal((await post('phone', { on: true })).status, 400, 'no folders are set');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('board-sessions') });
  assert.equal((await post('phone', { on: true })).status, 400, 'board_larmor_dir is not set');
  writeJson(path.join(home, 'config.json'), { board_larmor_dir: tmp('board-larmor-bare') });
  assert.equal((await post('phone', { on: false })).status, 400, 'no venv or voice_ctl to run');
  writeJson(path.join(home, 'config.json'), {
    board_larmor_dir: larmor,
  });
  assert.equal((await post('phone', {})).status, 400, 'on is needed');
  assert.equal((await post('phone', { on: 'yes' })).status, 400);
  // phone mode does not need voice: with voice off Larmor is asked all the same
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  const turned = await post('phone', { on: true });
  assert.equal(turned.status, 200);
  assert.deepEqual(JSON.parse(turned.text), { ok: true, on: true, bridge: true });
  assert.equal(calls(), 'app/voice_ctl.py phone-on\n');
  assert.equal((await post('phone', { on: false })).status, 200);
  const stopped = await post('phone/bridge-stop', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(JSON.parse(stopped.text), { ok: true, on: false, bridge: false });
  assert.equal(
    calls(),
    'app/voice_ctl.py phone-on\napp/voice_ctl.py phone-off\napp/voice_ctl.py bridge-stop\n',
  );
  // Larmor refuses (not paired, firewall, wrong network): its reason comes back as a 409
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  writeFileSync(path.join(larmor, 'refuse'), '');
  const refused = await post('phone', { on: true });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /isn.t paired yet/);
  // no answer from voice_ctl at all
  writeFileSync(path.join(larmor, 'silent'), '');
  assert.equal((await post('phone/bridge-stop', {})).status, 502);
  // one call at a time: while Larmor works on the first, the second is refused
  rmSync(path.join(larmor, 'silent'));
  rmSync(path.join(larmor, 'refuse'));
  writeFileSync(path.join(larmor, 'slow'), '');
  const first = post('phone', { on: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await post('phone', { on: false });
  assert.equal(second.status, 409);
  assert.match(second.text, /still working/);
  assert.equal((await first).status, 200);
  assert.equal((await post('phone', { on: false })).status, 200, 'free again');
  // another page's key doesn't reach them
  assert.equal((await post('phone', { on: true }, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post('phone/bridge-stop', {}, pageKey(TOKEN, 'x'))).status, 403);
});

test('POST /api/board/voice/start and /stop ask Larmor’s voice_ctl with the board key, one at a time, and carry its refusal', async () => {
  const home = tmp('board-voice-start-post');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor(voiceDir);
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, { Authorization: `Bearer ${key}` });
  const calls = () => readFileSync(path.join(larmor, 'calls.log'), 'utf8');
  assert.equal((await post('start', {})).status, 400, 'no folders are set');
  writeJson(path.join(home, 'config.json'), {
    board_larmor_dir: larmor,
  });
  const bad = await post('start', { session: '--help' });
  assert.equal(bad.status, 400, bad.text);
  assert.equal((await post('start', { session: 5 })).status, 400);
  const started = await post('start', { session: 'sess-1' });
  assert.equal(started.status, 200);
  assert.deepEqual(JSON.parse(started.text), { ok: true, voice: true });
  assert.equal((await post('start', {})).status, 200, 'the session is optional');
  const stopped = await post('stop', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(JSON.parse(stopped.text), { ok: true, voice: false });
  assert.equal(
    calls(),
    'app/voice_ctl.py start sess-1\napp/voice_ctl.py start\napp/voice_ctl.py stop\n',
  );
  writeFileSync(path.join(larmor, 'refuse'), '');
  const refused = await post('start', { session: 'sess-1' });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /already on in another session/);
  rmSync(path.join(larmor, 'refuse'));
  // one call at a time across start, stop and the phone buttons
  writeFileSync(path.join(larmor, 'slow'), '');
  const first = post('start', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await post('stop', {})).status, 409);
  assert.equal((await first).status, 200);
  assert.equal((await post('start', {}, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post('stop', {}, pageKey(TOKEN, 'x'))).status, 403);
});

test('POST /api/board/type and /stop-listening: the board key, a live idle session in the right repo, nothing else', async () => {
  const home = tmp('board-type-route');
  const sessions = tmp('board-sessions');
  const checkout = checkoutOf('widgets', 'main');
  registry(sessions, process.pid, { cwd: checkout, status: 'busy' }, procStartOf(process.pid));
  registry(sessions, process.ppid, { cwd: checkout, name: 'idle-one' });
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, "#!/bin/sh\necho '[]'\n");
  chmodSync(it2, 0o755);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', route, body, { Authorization: `Bearer ${key}` });
  assert.equal((await post('/api/board/type', {})).status, 400);
  assert.equal(
    (await post('/api/board/type', { kind: 'rm', session: fullId(process.pid) })).status,
    400,
  );
  assert.equal(
    (await post('/api/board/type', { kind: 'listen', session: 'nope', repo: 'acme/widgets' }))
      .status,
    404,
  );
  const busy = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.pid),
    repo: 'acme/widgets',
  });
  assert.equal(busy.status, 409);
  assert.match(busy.text, /session busy/);
  const wrongRepo = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.ppid),
    repo: 'acme/gadgets',
  });
  assert.match(wrongRepo.text, /not in a checkout of acme\/gadgets/);
  assert.equal(
    (
      await post('/api/board/type', {
        kind: 'listen',
        session: fullId(process.ppid),
        repo: 'not a repo',
      })
    ).status,
    400,
  );
  const nothing = await post('/api/board/type', { kind: 'build', session: fullId(process.ppid) });
  assert.match(nothing.text, /nothing to build/);
  // a session whose tab can't be found is not typed into
  const noTab = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.ppid),
    repo: 'acme/widgets',
  });
  assert.equal(noTab.status, 409);
  assert.match(noTab.text, /no iTerm tab/);
  for (const key of [pageKey(TOKEN, 'x')]) {
    assert.equal(
      (await post('/api/board/type', { kind: 'listen', session: 's', repo: 'a/b' }, key)).status,
      403,
    );
    assert.equal((await post('/api/board/stop-listening', { repo: 'a/b' }, key)).status, 403);
  }
  // stop: a request for the repo, which a wait that started before it sees
  assert.equal((await post('/api/board/stop-listening', { repo: 'bad repo' })).status, 400);
  const before = Date.now();
  assert.equal((await post('/api/board/stop-listening', { repo: 'acme/widgets' })).status, 200);
  assert.equal(stopRequested(home, 'acme/widgets', before - 1000), 'stopped from the board');
});

test('the bridge lists local stories beside the PR stories: Mark reviewed, a story left by the retired turn capture left out', async () => {
  const home = tmp('board-inbox');
  const widgets = checkoutOf('widgets', 'feat/x');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-widgets-feat-x', widgets, 'feat/x');
  localStory(
    home,
    'local-widgets-seen',
    widgets,
    'feat/seen',
    {},
    {
      'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' },
    },
  );
  // a story the retired turn capture left carries `turn`, and is not listed
  localStory(home, 'turn-abc', widgets, null, { turn: 'abc', title: 'widgets: a turn' });
  const bridge = await startBridge({ home });
  open.push(bridge);

  const list = storyList(bridge);
  assert.deepEqual(
    list.local_stories
      .map((story) => [story.id, story.repo, story.branch, story.title, story.reviewed_at !== null])
      .sort(),
    [
      ['local-widgets-feat-x', 'acme/widgets', 'feat/x', 'Story of local-widgets-feat-x', false],
      ['local-widgets-seen', 'acme/widgets', 'feat/seen', 'Story of local-widgets-seen', true],
    ],
    'both local stories, not the one a turn made',
  );
  assert.deepEqual(
    list.stories.map((story) => story.id),
    ['acme-widgets-7'],
    'PR stories are as before',
  );
  // Mark reviewed, the way a PR story is, and unmark
  assert.ok(markReviewed(bridge, 'local-widgets-feat-x')?.reviewed_at);
  assert.equal(storyList(bridge).local_stories.filter((story) => !story.reviewed_at).length, 0);
  markReviewed(bridge, 'local-widgets-feat-x', false);
  const undone = storyList(bridge);
  assert.equal(
    undone.local_stories.find((story) => story.id === 'local-widgets-feat-x')?.reviewed_at,
    null,
  );
  assert.equal(markReviewed(bridge, 'turn-abc'), null);
  // the board key hands out the same link
  const asBoard = await bridge.call(
    'POST',
    '/api/board/open-story',
    { story: 'local-widgets-feat-x' },
    { Authorization: `Bearer ${boardKey(TOKEN)}` },
  );
  assert.equal(asBoard.status, 200);
  assert.equal(
    (
      await bridge.call(
        'POST',
        '/api/board/open-story',
        { story: 'turn-abc' },
        { Authorization: `Bearer ${boardKey(TOKEN)}` },
      )
    ).status,
    404,
  );
});

test('a story’s own listen routes: the local page’s full key and the token reach them, the read-only key, the board key and another story’s key do not', async () => {
  const home = tmp('story-listen-routes');
  const sessions = tmp('board-sessions');
  mkdirSync(sessions, { recursive: true });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const widgets = checkoutOf('widgets', 'feat/x');
  const bare = tmp('board-no-remote');
  git(bare, 'init', '-q', '-b', 'main');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-feat-x', widgets, 'feat/x');
  localStory(home, 'local-bare', bare, 'main');
  localStory(home, 'local-nowhere', '', 'main');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const viaKey = (method: 'GET' | 'POST', route: string, key: string, body?: unknown) =>
    bridge.call<{ repo?: string; sessions?: unknown[]; error?: string }>(method, route, body, {
      Authorization: `Bearer ${key}`,
    });
  for (const key of [TOKEN, pageKey(TOKEN, 'local-feat-x')]) {
    const got = await viaKey('GET', '/api/stories/local-feat-x/listen', key);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      repo: 'acme/widgets',
      sessions: [],
      line: '/once-upon-listen acme/widgets --keep',
      storyLine: '/once-upon-listen --story local-feat-x --keep',
      typing: true,
    });
    // reached: the board looks for the session and finds none
    for (const scope of ['repo', 'story']) {
      const sent = await viaKey('POST', '/api/stories/local-feat-x/listen', key, {
        session: 'nope',
        scope,
      });
      assert.equal(sent.status, 404, scope);
      assert.match(String(sent.body.error), /no live Claude Code session/);
    }
    assert.equal((await viaKey('POST', '/api/stories/local-feat-x/listen', key, {})).status, 400);
    assert.equal(
      (await viaKey('POST', '/api/stories/local-feat-x/listen', key, { session: 'a b; rm' }))
        .status,
      400,
      'no text to type',
    );
  }
  // a PR story, by the extension's token
  assert.equal(
    (await viaKey('GET', '/api/stories/acme-widgets-7/listen', TOKEN)).body.repo,
    'acme/widgets',
  );
  // a local story whose checkout has no origin finds sessions by the checkout: the story's own listener can be asked for,
  // the repo's cannot, and with no checkout either there is nothing to find a session by
  const bareList = await viaKey('GET', '/api/stories/local-bare/listen', TOKEN);
  assert.deepEqual(
    [bareList.status, bareList.body],
    [
      200,
      {
        repo: null,
        sessions: [],
        line: '/once-upon-listen --story local-bare --keep',
        typing: true,
      },
    ],
  );
  assert.equal(
    (
      await viaKey('POST', '/api/stories/local-bare/listen', TOKEN, {
        session: 'nope',
        scope: 'story',
      })
    ).status,
    404,
    'reached: the session is looked for',
  );
  assert.equal(
    (await viaKey('POST', '/api/stories/local-bare/listen', TOKEN, { session: 'nope' })).status,
    400,
    "no repo, so no repo's listener",
  );
  assert.equal((await viaKey('GET', '/api/stories/local-nowhere/listen', TOKEN)).status, 400);
  // a read-only link never types into a terminal; neither do the board's key or another story's
  for (const key of [
    viewKey(TOKEN, 'local-feat-x'),
    boardKey(TOKEN),
    pageKey(TOKEN, 'local-bare'),
  ]) {
    assert.equal((await viaKey('GET', '/api/stories/local-feat-x/listen', key)).status, 403);
    assert.equal(
      (await viaKey('POST', '/api/stories/local-feat-x/listen', key, { session: 'x' })).status,
      403,
    );
  }
});

test('GET /api/board/listen-sessions: the board key or the token, a repo or a story, nothing from the other pages’ keys', async () => {
  const home = tmp('board-listen-sessions-route');
  const sessions = tmp('board-sessions');
  mkdirSync(sessions, { recursive: true });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  const bridge = await startBridge({ home });
  open.push(bridge);
  const get = (route: string, key: string) =>
    bridge.call<{ repo: string; sessions: unknown[] }>('GET', route, undefined, {
      Authorization: `Bearer ${key}`,
    });
  for (const key of [TOKEN, boardKey(TOKEN)]) {
    const byRepo = await get('/api/board/listen-sessions?repo=acme/widgets', key);
    assert.equal(byRepo.status, 200);
    assert.deepEqual(byRepo.body, {
      repo: 'acme/widgets',
      sessions: [],
      line: '/once-upon-listen acme/widgets --keep',
      typing: true,
    });
    const byStory = await get('/api/board/listen-sessions?story=acme-widgets-7', key);
    assert.deepEqual(
      byStory.body,
      {
        repo: 'acme/widgets',
        sessions: [],
        line: '/once-upon-listen acme/widgets --keep',
        storyLine: '/once-upon-listen --story acme-widgets-7 --keep',
        typing: true,
      },
      "the story's own repo",
    );
  }
  assert.equal((await get('/api/board/listen-sessions', TOKEN)).status, 400);
  assert.equal((await get('/api/board/listen-sessions?repo=not%20a%20repo', TOKEN)).status, 400);
  assert.equal((await get('/api/board/listen-sessions?story=nope', TOKEN)).status, 404);
  for (const key of [pageKey(TOKEN, 'acme-widgets-7')]) {
    assert.equal(
      (await get('/api/board/listen-sessions?repo=acme/widgets', key)).status,
      403,
      "the board's route",
    );
  }
});

test('POST /api/board/review: a session’s branch becomes a storyless review over its merge-base, and its page link comes back', async () => {
  const home = tmp('board-review');
  const sessions = tmp('board-sessions');
  const fixture = worktreeFixture();
  const dir = fixture.add('feat/x');
  fixture.commit(dir, 'x one');
  // origin's main is where feat/x began; main has moved on since, so the base is the merge-base, not main's tip
  const forkPoint = git(fixture.main, 'rev-parse', 'HEAD');
  git(fixture.main, 'update-ref', 'refs/remotes/origin/main', forkPoint);
  fixture.commit(fixture.main, 'main later', 3);
  const child = liveChild();
  after(() => child.stop());
  registry(sessions, child.pid, { cwd: dir, name: 'on-x' }, child.procStart);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const cardOnX = async () =>
    (await bridge.call<BoardData>('GET', '/api/board')).body.lanes
      .flatMap((lane) => lane.cards)
      .find((one) => one.branch === 'feat/x') as BoardCard;
  const post = (body: unknown, key = boardKey(TOKEN)) =>
    bridge.call<{ url: string; story: string }>('POST', '/api/board/review', body, {
      Authorization: `Bearer ${key}`,
    });
  const before = await cardOnX();
  assert.deepEqual(before.review, { branch: 'feat/x', path: dir });
  assert.equal((await post({ card: before.id }, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post({ card: 'branch:nope@nope' })).status, 404);

  // the path is the card's, never the body's
  const made = await post({ card: before.id, path: '/etc', branch: 'main' });
  assert.equal(made.status, 200, made.text);
  const { story, url } = made.body;
  assert.match(url, new RegExp(`/local/${story}/`));
  const folder = path.join(dir, '.once-upon', story);
  const meta = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.base, forkPoint);
  assert.equal(meta.head, 'feat/x');
  assert.equal(meta.branch, 'feat/x', 'a branch, so Create pull request is offered');
  assert.equal(
    JSON.parse(readFileSync(path.join(folder, 'chapters.json'), 'utf8')).mode,
    'by-folder',
  );
  assert.match(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /changed-x one/);
  assert.doesNotMatch(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /main later/);

  // the branch has its story now: a work card with Open story, and Build story still tells one. Review stays while
  // the story is storyless, so a branch that moved on can be reviewed again
  const reviewed = await cardOnX();
  assert.equal(reviewed.kind, 'work');
  assert.equal(reviewed.story?.id, story);
  assert.equal(reviewed.story?.storyless, true);
  assert.deepEqual(reviewed.review, { branch: 'feat/x', path: dir });
  assert.ok(reviewed.build, 'Build story is still offered on a storyless review');
  fixture.commit(dir, 'x two', 2);
  const again = await post({ card: reviewed.id });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.story, story, 'the same story');
  const repinned = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8'));
  assert.equal(repinned.head_oid, git(dir, 'rev-parse', 'HEAD'), 're-pinned to the new tip');
  assert.match(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /changed-x two/);
});
