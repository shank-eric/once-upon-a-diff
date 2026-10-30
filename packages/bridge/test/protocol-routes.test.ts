import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  tmp,
  githubStory,
  startBridge,
  localRepo,
  writeJson,
  TOKEN,
  type TestBridge,
} from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { API_ROUTES, STORY_ROUTES } from '../src/server/index.ts';
import { boardKey, pageKey, viewKey, viewKeyMay } from '../src/server/page-key.ts';
import { ROUTES, boardKeyMay, type AnyRoute } from '@once-upon-a-diff/protocol/routes';

const ENTRIES = Object.entries(ROUTES as Record<string, AnyRoute>);
const TABLE = ENTRIES.map(([, route]) => route);
const API_TABLE = TABLE.filter(
  (route) => route.what === undefined && route.path.startsWith('/api/'),
);
const STORY_TABLE = TABLE.filter((route) => route.what !== undefined);

async function bridgeWithStories() {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      {
        title: 'Chapter 1: One',
        files: ['one.txt'],
        comments: [{ path: 'one.txt', line: 2, body: 'Fix' }],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const other = createLocalStory({ home, repo, base, head: 'HEAD', chapters, id: 'other-local' });
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  return { home, id, other: other.id, bridge };
}

const withKey = (bridge: TestBridge, key: string, method: string, url: string, body?: unknown) =>
  bridge.call<{ error?: string }>(method, url, body, { Authorization: `Bearer ${key}` });

const urlOf = (route: AnyRoute, id: string) =>
  route.path.replace(':id', encodeURIComponent(id)).replace(':note', 'n1');

test('every route the bridge registers is in the table, and every table route is registered', () => {
  const registered = new Set<AnyRoute>(
    [...API_ROUTES, ...STORY_ROUTES].map((entry) => entry.route),
  );
  for (const route of registered) {
    assert.ok(
      TABLE.includes(route),
      `${route.method} ${route.path} is registered but not in ROUTES`,
    );
  }
  for (const route of API_TABLE) {
    assert.ok(
      API_ROUTES.some(
        (entry) => entry.route.method === route.method && entry.route.path === route.path,
      ),
      `${route.method} ${route.path} has no handler`,
    );
  }
  for (const route of STORY_TABLE) {
    assert.ok(
      STORY_ROUTES.some(
        (entry) => entry.route.what === route.what && entry.route.method === route.method,
      ),
      `${route.method} ${route.path} has no handler`,
    );
  }
  // POST /auth/session is answered by the bridge itself, before the routes
  assert.equal(TABLE.length, API_TABLE.length + STORY_TABLE.length + 1);
});

/**
 * What the board page's key may call, written out and not read from the table: the routes that had `boardKey: true` in
 * routes/board.ts before the table took over (60964b3). Widening the board key's reach is a change to this list.
 */
const BOARD_KEY_REACH = [
  'GET /api/board',
  'GET /api/board/listen-sessions',
  'POST /api/board/backlog',
  'POST /api/board/backlog/assign',
  'POST /api/board/backlog/drop',
  'POST /api/board/backlog/move',
  'POST /api/board/focus',
  'POST /api/board/open-story',
  'POST /api/board/reviewed',
  'POST /api/board/stop-listening',
  'POST /api/board/type',
  'POST /api/board/voice/pause',
  'POST /api/board/voice/phone',
  'POST /api/board/voice/phone/bridge-stop',
  'POST /api/board/worktree/clean',
];

/**
 * What the read-only story key may call, by the route's `what` ('' is the story itself) and method: the old
 * VIEW_KEY_MAY in page-key.ts at 60964b3, one pair per entry.
 */
const VIEW_KEY_REACH = [
  'GET ',
  'GET version',
  'GET pulse',
  'GET freshness',
  'GET status',
  'GET working',
  'GET prefs',
  'POST prefs',
  'GET ui',
  'POST ui',
  'POST seen',
  'POST position',
  'GET read',
  'POST read',
  'GET drafts',
  'POST drafts',
  'GET questions',
  'POST questions',
  'POST viewed',
  'POST notes',
  'GET fixes',
  'POST fixes',
  'GET rebuild',
  'POST rebuild',
  'GET pr',
];

test('the board key reaches the routes on a written-out list and no others', () => {
  const reach = API_TABLE.filter((route) => boardKeyMay(route)).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(reach.sort(), [...BOARD_KEY_REACH].sort());
  // and no route with a story in its path is on the list, so the board key never reaches a story
  assert.ok(STORY_TABLE.every((route) => !boardKeyMay(route)));
});

test("a story route's keys agree with page-key.ts's read-only list, both ways", () => {
  // the table's side: the routes marked for the read-only key are on the written-out list
  const marked = new Set(
    STORY_TABLE.filter((route) => route.keys === 'token+page+view').map(
      (route) => `${route.method} ${route.what}`,
    ),
  );
  for (const pair of marked) {
    assert.ok(VIEW_KEY_REACH.includes(pair), `${pair} is marked read-only in the table`);
  }
  for (const route of STORY_TABLE) {
    assert.equal(
      viewKeyMay(route.what as string, route.method),
      route.keys === 'token+page+view',
      `${route.method} ${route.path}`,
    );
  }
  // page-key.ts's side: it allows what is on the list for every `what` it or the table knows, and nothing else
  const whats = new Set([
    ...VIEW_KEY_REACH.map((pair) => pair.slice(pair.indexOf(' ') + 1)),
    ...STORY_TABLE.map((route) => route.what as string),
    'approve',
    'push',
    'listen',
    'nope',
    '__proto__',
  ]);
  for (const what of whats) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal(
        viewKeyMay(what, method),
        VIEW_KEY_REACH.includes(`${method} ${what}`),
        `${method} ${what}`,
      );
    }
  }
  // every pair on the list that has a route in the table is marked read-only there
  for (const route of STORY_TABLE) {
    if (VIEW_KEY_REACH.includes(`${route.method} ${route.what}`)) {
      assert.equal(route.keys, 'token+page+view', `${route.method} ${route.path}`);
    }
  }
});

test('the keys do what the table says: none gets 401, the board key and the story keys reach only theirs', async () => {
  const { id, bridge } = await bridgeWithStories();
  try {
    for (const route of API_TABLE) {
      const body = route.method === 'POST' ? {} : undefined;
      const url = route.path;
      assert.equal(
        (await bridge.call(route.method, url, body, { Authorization: '' })).status,
        401,
        `no key: ${route.method} ${url}`,
      );
      const board = (await withKey(bridge, boardKey(TOKEN), route.method, url, body)).status;
      if (boardKeyMay(route)) {
        assert.ok(
          ![401, 403].includes(board),
          `the board key reaches ${route.method} ${url}, got ${board}`,
        );
      } else {
        assert.equal(board, 403, `the board key is refused ${route.method} ${url}`);
      }
      assert.equal(
        (await withKey(bridge, pageKey(TOKEN, id), route.method, url, body)).status,
        403,
        `a story key never reaches ${route.method} ${url}`,
      );
    }
    for (const route of STORY_TABLE) {
      const body = route.method === 'POST' ? {} : undefined;
      const url = urlOf(route, id);
      assert.equal(
        (await bridge.call(route.method, url, body, { Authorization: '' })).status,
        401,
        url,
      );
      assert.equal(
        (await withKey(bridge, boardKey(TOKEN), route.method, url, body)).status,
        403,
        `board key: ${url}`,
      );
      const full = (await withKey(bridge, pageKey(TOKEN, id), route.method, url, body)).status;
      assert.ok(
        ![401, 403].includes(full),
        `the full key reaches ${route.method} ${url}, got ${full}`,
      );
      const view = (await withKey(bridge, viewKey(TOKEN, id), route.method, url, body)).status;
      if (route.keys === 'token+page+view') {
        assert.ok(
          ![401, 403].includes(view),
          `the read-only key reaches ${route.method} ${url}, got ${view}`,
        );
      } else {
        assert.equal(view, 403, `the read-only key is refused ${route.method} ${url}`);
      }
    }
  } finally {
    await bridge.close();
  }
});

test('a malformed body never changes which guard answers first', async () => {
  const { id, other, bridge } = await bridgeWithStories();
  try {
    const bad = { text: 5, action: 'nonsense', session: {}, head_sha: 5 };
    // no key: 401, for a story route and a bridge-wide one
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/questions`, bad, { Authorization: '' }))
        .status,
      401,
    );
    assert.equal(
      (await bridge.call('POST', '/api/board/type', bad, { Authorization: '' })).status,
      401,
    );
    // another story's key: 403
    assert.equal(
      (await withKey(bridge, pageKey(TOKEN, other), 'POST', `/api/stories/${id}/questions`, bad))
        .status,
      403,
    );
    // the read-only key on what it may not do: 403, never the 400 the body would earn
    for (const what of ['pr', 'push', 'approve', 'listen']) {
      assert.equal(
        (await withKey(bridge, viewKey(TOKEN, id), 'POST', `/api/stories/${id}/${what}`, bad))
          .status,
        403,
        what,
      );
    }
    // a page key on a PR story: 403, and Add to my review through a page key too
    assert.equal(
      (
        await withKey(
          bridge,
          pageKey(TOKEN, 'acme-widgets-7'),
          'POST',
          '/api/stories/acme-widgets-7/questions',
          bad,
        )
      ).status,
      403,
    );
    const review = await withKey(bridge, pageKey(TOKEN, id), 'POST', `/api/stories/${id}/drafts`, {
      chapter: 'x',
      index: 'y',
      action: 'review',
    });
    assert.equal(review.status, 403, 'the page key never adds to a GitHub review');
    // the board's key on a story route: 403
    assert.equal(
      (await withKey(bridge, boardKey(TOKEN), 'POST', `/api/stories/${id}/questions`, bad)).status,
      403,
    );
    // a write with no JSON content type is 415 before the body is read, and an over-size one 413
    const res = await fetch(`${bridge.base}/api/stories/${id}/questions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: '{"text":5}',
    });
    assert.equal(res.status, 415);
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/questions`, { text: 'x'.repeat(300 * 1024) }))
        .status,
      413,
    );
    // with every guard passed it is the schema that answers: 400 with the page's message
    const asked = await bridge.call<{ error: string }>('POST', `/api/stories/${id}/questions`, bad);
    assert.equal(asked.status, 400);
    assert.equal(asked.body.error, 'text is required');
    const viaView = await withKey(
      bridge,
      viewKey(TOKEN, id),
      'POST',
      `/api/stories/${id}/questions`,
      bad,
    );
    assert.equal(viaView.status, 400, 'the read-only key may ask, so its bad body is a 400');
    // a body that is not an object is a 400 whatever its route
    for (const raw of ['null', '5', '[]', '"x"']) {
      const response = await fetch(`${bridge.base}/api/board/focus`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${boardKey(TOKEN)}`, 'Content-Type': 'application/json' },
        body: raw,
      });
      assert.equal(response.status, 400, raw);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'body must be a JSON object',
      );
    }
  } finally {
    await bridge.close();
  }
});

test('a bad body is refused before anything is stored', async () => {
  const { home, id, bridge } = await bridgeWithStories();
  try {
    const before = (
      await bridge.call<{ questions: unknown[] }>('GET', `/api/stories/${id}/questions`)
    ).body.questions.length;
    for (const body of [{ text: 5 }, { text: {} }, { text: ['a'] }, {}]) {
      assert.equal((await bridge.call('POST', `/api/stories/${id}/questions`, body)).status, 400);
    }
    assert.equal(
      (await bridge.call<{ questions: unknown[] }>('GET', `/api/stories/${id}/questions`)).body
        .questions.length,
      before,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/position`, { step: 1, chapter: ['x'] }))
        .status,
      400,
    );
    assert.equal(
      (await bridge.call('POST', '/api/prefs', { hideWhitespace: 'yes', diffView: 'sideways' }))
        .status,
      200,
      'page settings still drop nonsense',
    );
    assert.ok(home.length > 0);
  } finally {
    await bridge.close();
  }
});

test('the bridge serves the route table, the client and the patterns as JavaScript with no valibot, and never the schemas', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    const served: Record<string, string> = {};
    for (const name of ['routes', 'client', 'domain/patterns']) {
      const response = await bridge.call('GET', `/assets/protocol/${name}.ts`, undefined, {
        Authorization: '',
      });
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      const loads = [
        ...response.text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
      ].map((hit) => hit[1]);
      assert.ok(
        loads.every((specifier) => specifier.startsWith('./') && !specifier.includes('schemas')),
        `${name} loads ${loads}`,
      );
      assert.ok(!response.text.includes(TOKEN));
      served[name] = response.text;
    }
    for (const name of ['schemas', 'types', 'nope', 'domain/other']) {
      const response = await bridge.call('GET', `/assets/protocol/${name}.ts`, undefined, {
        Authorization: '',
      });
      assert.equal(response.status, 404, name);
      assert.ok(!response.text.includes('safeParse'));
    }
    // what the browser gets runs: the client imports the table by the same relative path
    const dir = tmp('served');
    mkdirSync(path.join(dir, 'protocol'));
    for (const [name, code] of Object.entries(served)) {
      mkdirSync(path.dirname(path.join(dir, 'protocol', `${name}.ts`)), { recursive: true });
      writeFileSync(path.join(dir, 'protocol', `${name}.ts`), code);
    }
    const client = await import(path.join(dir, 'protocol', 'client.ts'));
    const routes = await import(path.join(dir, 'protocol', 'routes.ts'));
    assert.equal(typeof client.createClient, 'function');
    assert.equal(
      client.pathFor(routes.ROUTES.story, { params: { id: 'a b' } }),
      '/api/stories/a%20b',
    );
  } finally {
    await bridge.close();
  }
});
