import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, type AnyRoute } from '@once-upon-a-diff/protocol/routes';
import {
  createClient,
  matchRoute,
  pathFor,
  bridgeProblem,
  BridgeError,
  type CallRequest,
} from '../src/client.ts';

const ENTRIES = Object.entries(ROUTES as Record<string, AnyRoute>);

test('pathFor fills and encodes a route’s params and query', () => {
  assert.equal(pathFor(ROUTES.story, { params: { id: 'a/b c' } }), '/api/stories/a%2Fb%20c');
  assert.equal(
    pathFor(ROUTES.noteUpdate, { params: { id: 'x', note: 'n1' }, body: {} }),
    '/api/stories/x/notes/n1',
  );
  assert.equal(
    pathFor(ROUTES.status, { query: { story: 's1', repo: 'o/r' } }),
    '/api/status?story=s1&repo=o%2Fr',
  );
  assert.equal(pathFor(ROUTES.status, { query: { story: undefined } }), '/api/status');
  assert.throws(() => pathFor(ROUTES.story, {}), /needs id/);
});

test('matchRoute takes the table’s /api/ paths with their method and nothing else', () => {
  assert.ok(matchRoute('GET', '/api/health'));
  assert.ok(!matchRoute('POST', '/api/health'), 'the table has no POST health');
  assert.ok(matchRoute('GET', '/api/board/link?public=1'));
  assert.ok(matchRoute('POST', '/api/stories/status-many'));
  assert.ok(matchRoute('POST', '/api/stories/acme-widgets-7/questions/marks'));
  assert.ok(matchRoute('GET', '/api/status?story=a%2Fb'));
  assert.ok(!matchRoute('GET', '/api/nope'));
  assert.ok(!matchRoute('GET', '/api/stories/../health'));
  assert.ok(!matchRoute('GET', '/api/stories/a/../../health'));
  assert.ok(!matchRoute('GET', '/api/stories/./status'));
  assert.ok(!matchRoute('GET', '/auth/session'));
  assert.ok(!matchRoute('GET', '/api/health?x=<script>'));
  assert.ok(!matchRoute('GET', 'http://evil.test/api/health'));
  for (const [name, route] of ENTRIES) {
    if (route.path.startsWith('/api/')) {
      const filled = route.path.replace(/:[a-z]+/g, 'x1');
      assert.ok(matchRoute(route.method, filled), name);
    }
  }
});

test('matchRoute refuses a dot segment written percent-encoded, in any case', () => {
  for (const path of [
    '/api/stories/%2e%2e/status',
    '/api/stories/%2E%2E/status',
    '/api/stories/%2e./status',
    '/api/stories/.%2E/status',
    '/api/stories/%2e/status',
    '/api/stories/x/%2e%2E/%2e%2e/health',
  ]) {
    assert.ok(!matchRoute('GET', path), path);
  }
  // an id with a dot in it is fine, and so is one that only looks like an escape
  assert.ok(matchRoute('GET', '/api/stories/a.b/status'));
  assert.ok(matchRoute('GET', '/api/stories/a%2Fb/status'));
});

test('matchRoute can be held to a list of routes', () => {
  const only = [ROUTES.health, ROUTES.status];
  assert.ok(matchRoute('GET', '/api/health', only));
  assert.ok(matchRoute('GET', '/api/status?story=a', only));
  assert.ok(!matchRoute('POST', '/api/board/type', only));
  assert.ok(!matchRoute('GET', '/api/stories', only));
});

test('the client sends a POST with a body ({} when it has none) and never a GET with one', async () => {
  const sent: CallRequest[] = [];
  const client = createClient(async (request) => {
    sent.push(request);
    return { ok: true, status: 200, body: { ok: true } };
  });
  await client.call(ROUTES.boardVoiceBridgeStop);
  await client.call(ROUTES.health);
  await client.call(ROUTES.boardFocus, { body: { session: 's1' } });
  assert.deepEqual(sent, [
    { method: 'POST', path: '/api/board/voice/phone/bridge-stop', body: {} },
    { method: 'GET', path: '/api/health' },
    { method: 'POST', path: '/api/board/focus', body: { session: 's1' } },
  ]);
});

test('ask gives the answer, and throws a BridgeError with the status when the call failed', async () => {
  const good = createClient(async () => ({ ok: true, status: 200, body: { version: '1' } }));
  assert.deepEqual(await good.ask(ROUTES.storyVersion, { params: { id: 'a' } }), { version: '1' });
  const bad = createClient(async () => ({ ok: false, status: 403, error: 'nope' }));
  await assert.rejects(bad.ask(ROUTES.health), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.message, 'nope');
    assert.equal(error.status, 403);
    return true;
  });
  const reply = await bad.call(ROUTES.health);
  assert.equal(reply.ok, false, 'call never throws');
});

test('bridgeProblem is decided by the status and the code, never by the message', () => {
  const failed = (status: number, body?: unknown) => ({ status, body });
  assert.equal(bridgeProblem(failed(0)), 'down');
  assert.equal(
    bridgeProblem(failed(401, { error: 'zzz reworded', code: 'unauthorized' })),
    'token',
  );
  assert.equal(bridgeProblem(failed(401, { error: 'no word of it' })), 'token', 'an older bridge');
  assert.equal(bridgeProblem(failed(404, { error: 'zzz', code: 'no_route' })), 'old');
  assert.equal(
    bridgeProblem(failed(404, { error: 'not found' })),
    'old',
    'an older bridge: no code',
  );
  assert.equal(
    bridgeProblem(failed(404, { error: 'not found', code: 'not_found' })),
    'down',
    'a story that is gone is not an old bridge',
  );
  assert.equal(
    bridgeProblem(failed(403, { error: 'this link needs a token', code: 'forbidden' })),
    'down',
    'a page key’s 403 is not a wrong token, whatever it says',
  );
  assert.equal(bridgeProblem(failed(500, { error: 'token' })), 'down');
});

test('a failed ask carries the bridge’s status and body, so the code can be read', async () => {
  const client = createClient(async () => ({
    ok: false,
    status: 404,
    body: { error: 'zzz', code: 'no_route' },
    error: 'zzz',
  }));
  const error = await client.ask(ROUTES.health).catch((caught: unknown) => caught);
  assert.ok(error instanceof BridgeError);
  assert.equal(error.status, 404);
  assert.equal(bridgeProblem(error), 'old');
});
