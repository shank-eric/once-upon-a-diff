/** Start listening with nothing to type into: the sessions routes answer with the line to run by hand, and the queue route writes the request the hook claims. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { tmp, git, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { boardKey, pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import { readPendingListen } from '@once-upon-a-diff/contracts/files/pending-listen';
import {
  checkoutOf,
  fakeIt2,
  localStory,
  prStory,
} from '@once-upon-a-diff/state/test/board-fixtures';

// findIt2 also looks in the user's own Applications folder: a test without it2 has an empty home
process.env.HOME = tmp('listen-anywhere-home');

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

type Offer = {
  repo: string | null;
  sessions: unknown[];
  line: string;
  storyLine?: string;
  typing: boolean;
};

/** A bridge with an empty session registry, with or without the it2 CLI (a path that does not exist when `it2` is false). */
async function bridgeWith(it2: boolean) {
  const home = tmp('listen-anywhere');
  const sessions = tmp('listen-anywhere-sessions');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2 ? fakeIt2() : path.join(tmp('no-it2'), 'it2'),
    board_status_source: 'registry',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  const checkout = tmp('listen-anywhere-bare');
  git(checkout, 'init', '-q', '-b', 'main');
  localStory(home, 'local-bare', checkout, 'main');
  localStory(home, 'local-feat-x', checkoutOf('widgets', 'feat/x'), 'feat/x');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const call = <T>(method: string, route: string, body?: unknown, key = boardKey(TOKEN)) =>
    bridge.call<T>(method, route, body, { Authorization: `Bearer ${key}` });
  return { home, bridge, call, checkout };
}

const pendingDir = (home: string) => path.join(home, 'pending-listen');

test('without the it2 CLI the sessions routes answer 200 with the line to run by hand, and typing stays refused', async () => {
  const { call } = await bridgeWith(false);
  const byRepo = await call<Offer>('GET', '/api/board/listen-sessions?repo=acme/widgets');
  assert.equal(byRepo.status, 200);
  assert.deepEqual(byRepo.body, {
    repo: 'acme/widgets',
    sessions: [],
    line: '/once-upon-listen acme/widgets --keep',
    typing: false,
  });
  const byStory = await call<Offer>('GET', '/api/board/listen-sessions?story=acme-widgets-7');
  assert.equal(byStory.status, 200);
  assert.equal(byStory.body.repo, 'acme/widgets');
  assert.equal(byStory.body.line, '/once-upon-listen acme/widgets --keep');
  assert.equal(byStory.body.storyLine, '/once-upon-listen --story acme-widgets-7 --keep');
  assert.equal(byStory.body.typing, false);
  // the story's own route, as the local page asks; a checkout with no origin gets the story's line
  const own = await call<Offer>('GET', '/api/stories/local-bare/listen', undefined, TOKEN);
  assert.equal(own.status, 200);
  assert.equal(own.body.repo, null);
  assert.equal(own.body.line, '/once-upon-listen --story local-bare --keep');
  assert.equal(own.body.typing, false);
  assert.equal(
    (
      await call('POST', '/api/board/type', {
        kind: 'listen',
        session: 'abc',
        repo: 'acme/widgets',
      })
    ).status,
    409,
    'typing still needs the tab',
  );
});

test('with the it2 CLI typing is true, and the answer carries the same line', async () => {
  const { call } = await bridgeWith(true);
  const got = await call<Offer>('GET', '/api/board/listen-sessions?repo=acme/widgets');
  assert.equal(got.body.typing, true);
  assert.equal(got.body.line, '/once-upon-listen acme/widgets --keep');
  assert.deepEqual(got.body.sessions, []);
});

test('POST /api/board/listen-queue writes one request per target, refreshes it on a second click, and refuses bad targets and other pages', async () => {
  const { home, call, checkout } = await bridgeWith(false);
  const queued = await call<{ ok: true; key: string; expires: number }>(
    'POST',
    '/api/board/listen-queue',
    { repo: 'acme/widgets' },
  );
  assert.equal(queued.status, 200, queued.text);
  assert.equal(queued.body.key, 'repo-acme-widgets');
  const file = path.join(pendingDir(home), 'repo-acme-widgets.json');
  const entry = readPendingListen(JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(entry);
  assert.equal(entry.repo, 'acme/widgets');
  assert.equal(entry.story ?? null, null);
  assert.equal(entry.expires, queued.body.expires);
  assert.ok(Math.abs(entry.expires - entry.at - 15 * 60 * 1000) < 1000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // a second click refreshes the one file
  await call('POST', '/api/board/listen-queue', { repo: 'acme/widgets' });
  assert.deepEqual(readdirSync(pendingDir(home)), ['repo-acme-widgets.json']);
  // a story: a PR story's repo, and a local one's checkout
  assert.equal(
    (await call('POST', '/api/board/listen-queue', { story: 'acme-widgets-7' })).status,
    200,
  );
  const prEntry = readPendingListen(
    JSON.parse(readFileSync(path.join(pendingDir(home), 'story-acme-widgets-7.json'), 'utf8')),
  );
  assert.equal(prEntry?.repo, 'acme/widgets');
  assert.equal(prEntry?.story, 'acme-widgets-7');
  assert.equal(
    (await call('POST', '/api/board/listen-queue', { story: 'local-bare' })).status,
    200,
  );
  const bare = readPendingListen(
    JSON.parse(readFileSync(path.join(pendingDir(home), 'story-local-bare.json'), 'utf8')),
  );
  assert.equal(bare?.checkout, checkout);
  assert.equal(bare?.repo ?? null, null);
  // the token reaches it too; bad input and the other pages' keys do not
  assert.equal(
    (await call('POST', '/api/board/listen-queue', { repo: 'acme/gadgets' }, TOKEN)).status,
    200,
  );
  assert.equal((await call('POST', '/api/board/listen-queue', { repo: 'bad repo' })).status, 400);
  assert.equal((await call('POST', '/api/board/listen-queue', { story: '../x' })).status, 400);
  assert.equal((await call('POST', '/api/board/listen-queue', {})).status, 400);
  assert.equal((await call('POST', '/api/board/listen-queue', { story: 'nope' })).status, 404);
  assert.equal(
    (await call('POST', '/api/board/listen-queue', { repo: 'a/b' }, pageKey(TOKEN, 'x'))).status,
    403,
  );
  assert.equal(existsSync(path.join(pendingDir(home), 'a-b.json')), false);
});

test('the story’s own queue route takes the story’s full key, for the repo or the story', async () => {
  const { home, call } = await bridgeWith(false);
  const key = pageKey(TOKEN, 'local-feat-x');
  const route = '/api/stories/local-feat-x/listen/queue';
  const first = await call('POST', route, {}, key);
  assert.equal(first.status, 200, first.text);
  assert.ok(existsSync(path.join(pendingDir(home), 'repo-acme-widgets.json')));
  assert.equal((await call('POST', route, { scope: 'story' }, key)).status, 200);
  assert.ok(existsSync(path.join(pendingDir(home), 'story-local-feat-x.json')));
  // a good key on another story is a 403 (a key that is no story's key is a 401, and a page forgets it)
  assert.equal((await call('POST', route, {}, pageKey(TOKEN, 'acme-widgets-7'))).status, 403);
});

test('a live listener for the target refuses the queue with 409, and writes nothing', async () => {
  const { home, call } = await bridgeWith(false);
  mkdirSync(path.join(home, 'listeners'), { recursive: true });
  writeJson(path.join(home, 'listeners', 'repo-acme-widgets.json'), {
    consumer: 'repo-acme-widgets',
    pid: process.pid,
    state: 'handling',
    at: new Date().toISOString(),
    repo: 'acme/widgets',
  });
  const refused = await call('POST', '/api/board/listen-queue', { repo: 'Acme/Widgets' });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /already listening/);
  assert.equal(existsSync(pendingDir(home)), false);
  // another repo is not covered by it
  assert.equal(
    (await call('POST', '/api/board/listen-queue', { repo: 'acme/gadgets' })).status,
    200,
  );
});

test('expired requests and old claimed leftovers are swept whenever a request is queued', async () => {
  const { home, call } = await bridgeWith(false);
  const dir = pendingDir(home);
  mkdirSync(path.join(dir, 'claimed'), { recursive: true });
  writeJson(path.join(dir, 'repo-old-one.json'), {
    v: 1,
    key: 'repo-old-one',
    repo: 'old/one',
    story: null,
    checkout: null,
    at: Date.now() - 3600_000,
    expires: Date.now() - 1000,
  });
  writeJson(path.join(dir, 'repo-bad-json.json'), { nonsense: true });
  const leftover = path.join(dir, 'claimed', 's.repo-x-y.json');
  writeJson(leftover, {});
  const old = new Date(Date.now() - 3600_000);
  utimesSync(leftover, old, old);
  await call('POST', '/api/board/listen-queue', { repo: 'acme/widgets' });
  assert.deepEqual(readdirSync(dir).sort(), ['claimed', 'repo-acme-widgets.json']);
  assert.deepEqual(readdirSync(path.join(dir, 'claimed')), []);
});
