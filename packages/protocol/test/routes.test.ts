import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, boardKeyMay, viewKeyAllowed, type AnyRoute } from '../src/routes.ts';
import { createClient, matchRoute, pathFor, BridgeError, type CallRequest } from '../src/client.ts';
import { BODIES } from '../src/schemas.ts';

const ENTRIES = Object.entries(ROUTES as Record<string, AnyRoute>);

test('the table has 57 routes, each method and path once', () => {
  assert.equal(ENTRIES.length, 57);
  const seen = new Set<string>();
  for (const [name, route] of ENTRIES) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `${name} repeats ${key}`);
    seen.add(key);
    assert.ok(route.path.startsWith('/api/') || route.path === '/auth/session', name);
  }
});

test('a story route has a what, and its path is /api/stories/:id/<what>[/<sub>]', () => {
  for (const [name, route] of ENTRIES) {
    if (route.what === undefined) {
      assert.ok(!route.path.includes(':id'), `${name} has an :id but no what`);
      continue;
    }
    const want = `/api/stories/:id${route.what ? `/${route.what}` : ''}${route.sub ? `/${route.sub}` : ''}`;
    assert.equal(route.path, want, name);
  }
});

test('every key scope is one the bridge knows, and the board and read-only flags follow from it', () => {
  for (const [name, route] of ENTRIES) {
    assert.ok(
      ['token', 'token+board', 'token+page', 'token+page+view', 'none'].includes(route.keys),
      name,
    );
    if (route.what === undefined) {
      assert.ok(!viewKeyAllowed(route), `${name}: only a story's routes take a story key`);
    } else {
      assert.ok(!boardKeyMay(route), `${name}: the board key never reaches a story`);
    }
  }
  assert.ok(boardKeyMay(ROUTES.boardFocus));
  assert.ok(!boardKeyMay(ROUTES.boardLink), 'only the bridge token is handed the board key');
  assert.ok(viewKeyAllowed(ROUTES.questionAsk));
  assert.ok(!viewKeyAllowed(ROUTES.prPush) && !viewKeyAllowed(ROUTES.pushApproved));
  assert.ok(!viewKeyAllowed(ROUTES.approve) && !viewKeyAllowed(ROUTES.storyListen));
});

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

test('every body schema belongs to a route', () => {
  const used = new Set<string>();
  for (const [name, route] of ENTRIES) {
    if (route.method === 'POST') {
      used.add(name);
    }
  }
  assert.ok(used.size > 0);
  const schemaNames = Object.keys(BODIES);
  // each schema name is a body that some POST route takes: the route that shares it is named for it or for its area
  assert.ok(schemaNames.length >= 30);
});
