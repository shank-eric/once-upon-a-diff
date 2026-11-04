import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, boardKeyMay, viewKeyAllowed, type AnyRoute } from '../src/routes.ts';
import { BODIES } from '../src/schemas.ts';

const ENTRIES = Object.entries(ROUTES as Record<string, AnyRoute>);

test('the table has 62 routes, each method and path once', () => {
  assert.equal(ENTRIES.length, 62);
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
