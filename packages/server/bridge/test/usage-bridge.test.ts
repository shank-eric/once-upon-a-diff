import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, githubStory, startBridge, TOKEN, localRepo } from './helpers.ts';
import { assertPrivate } from './usage-helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { pageKey, viewKey, boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import { UNPACKED_EXTENSION_ID } from '@once-upon-a-diff/foundation/settings';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { ACTIONS } from '@once-upon-a-diff/terms/usage-actions';
import { ROUTE_AREAS } from '@once-upon-a-diff/usage/areas';
import { UsageCounters } from '@once-upon-a-diff/usage/counters';
import { clearUsage } from '@once-upon-a-diff/usage/adapters/usage-file';
import { API_ROUTES, STORY_ROUTES } from '@once-upon-a-diff/server/index';

// the bridges here count even though no shim started the capture (a bridge in a test has its own temp home)
process.env.ONCE_UPON_USAGE = 'force';

interface Actions {
  days: Record<
    string,
    {
      routes: Record<string, Record<string, number>>;
      ui: Record<string, Record<string, number>>;
      unknownDropped?: number;
    }
  >;
}
const readActions = (home: string): Actions =>
  JSON.parse(readFileSync(path.join(home, 'usage', 'actions.json'), 'utf8'));
/** The one day's counts (the tests run within a day, ET). */
const today = (home: string) => Object.values(readActions(home).days)[0];

async function withStory() {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'T',
    chapters: [{ refs: [], title: 'Chapter 1: One', files: ['one.txt'] }],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  return { home, id, bridge };
}
const withKey = (key: string) => ({ Authorization: `Bearer ${key}` });

test('the bridge counts each route call under its key and who made it, and never the path', async () => {
  const { home, id, bridge } = await withStory();
  try {
    await bridge.call('GET', '/api/health'); // token
    await bridge.call('GET', '/api/board', undefined, withKey(boardKey(TOKEN))); // the board page
    await bridge.call('GET', `/api/stories/${id}/version`, undefined, withKey(pageKey(TOKEN, id))); // the story's page
    await bridge.call('GET', `/api/stories/${id}/version`, undefined, withKey(viewKey(TOKEN, id))); // its read-only link
    await bridge.call('GET', '/api/health', undefined, {
      Origin: `chrome-extension://${UNPACKED_EXTENSION_ID}`,
    });
    await bridge.call('GET', '/api/this-path-has-private-words'); // no such route
    await bridge.call('GET', '/api/health', undefined, withKey('wrong-token')); // fails the key check: not counted
    bridge.server.usage.flush();
    const { routes } = today(home);
    assert.deepEqual(routes.token, { health: 1, unmatched: 1 });
    assert.deepEqual(routes.board, { board: 1 });
    assert.deepEqual(routes.local, { storyVersion: 1 });
    assert.deepEqual(routes['local-view'], { storyVersion: 1 });
    assert.deepEqual(routes.extension, { health: 1 });
    assertPrivate(home, ['private-words']);
  } finally {
    await bridge.close();
  }
});

test('POST /api/usage keeps listed actions, drops the rest, and rejects a malformed batch', async () => {
  const { home, bridge } = await withStory();
  try {
    const sent = await bridge.call<{ on: boolean }>('POST', '/api/usage', {
      counts: {
        'board.tab.switch': 3,
        'board.lane.toggle': 1,
        'a story the user wrote about passwords': 5,
        '/Users/eric/secret.ts': 1,
        'board.idle.toggle': -2,
        'board.notes.copy': 1.5,
        'ext.prTag.click': 100000,
      },
      story_text: 'never stored',
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { on: true });
    const bad = await bridge.call('POST', '/api/usage', { counts: { 'board.tab.switch': 'many' } });
    assert.equal(bad.status, 400);
    const huge = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`x${i}`, 1]));
    assert.equal((await bridge.call('POST', '/api/usage', { counts: huge })).status, 400);
    assert.equal((await bridge.call('POST', '/api/usage', { nope: 1 })).status, 400);
    bridge.server.usage.flush();
    const day = today(home);
    assert.deepEqual(day.ui.token, { 'board.tab.switch': 3, 'board.lane.toggle': 1 });
    assert.equal(day.unknownDropped, 5);
    assert.deepEqual(day.routes.token, undefined, 'the usage routes are not counted as use');
    assertPrivate(home, ['passwords', 'secret', 'never stored']);
  } finally {
    await bridge.close();
  }
});

test("each key reaches its own usage route: the board's, a story page's, the read-only link's; no other story's", async () => {
  const { home, id, bridge } = await withStory();
  try {
    const batch = { counts: { 'local.fold.toggle': 2 } };
    assert.equal(
      (await bridge.call('POST', '/api/usage', batch, withKey(boardKey(TOKEN)))).status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/usage`, batch, withKey(pageKey(TOKEN, id))))
        .status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/usage`, batch, withKey(viewKey(TOKEN, id))))
        .status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', '/api/usage', batch, withKey(pageKey(TOKEN, id)))).status,
      403,
      'a story key is not bridge-wide',
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/usage`, batch, withKey(boardKey(TOKEN))))
        .status,
      403,
    );
    bridge.server.usage.flush();
    const { ui } = today(home);
    assert.deepEqual(ui.board, { 'local.fold.toggle': 2 });
    assert.deepEqual(ui.local, { 'local.fold.toggle': 2 });
    assert.deepEqual(ui['local-view'], { 'local.fold.toggle': 2 });
  } finally {
    await bridge.close();
  }
});

test('off in the settings file: the batch is answered {on: false} and nothing is counted or written', async () => {
  const home = tmp('home');
  writeJson(path.join(home, 'usage', 'settings.json'), { mode: 'off' });
  const bridge = await startBridge({ home });
  try {
    await bridge.call('GET', '/api/health');
    const answer = await bridge.call<{ on: boolean }>('POST', '/api/usage', {
      counts: { 'board.tab.switch': 1 },
    });
    assert.deepEqual(answer.body, { on: false });
    bridge.server.usage.flush();
    assert.ok(!existsSync(path.join(home, 'usage', 'actions.json')));
  } finally {
    await bridge.close();
  }
});

test('counts are written a few seconds after they arrive, not only on a flush', async () => {
  const home = tmp('home');
  const counters = new UsageCounters(home, new Set(['health']), () => true, undefined, 30);
  counters.route('health', 'token');
  assert.ok(!existsSync(path.join(home, 'usage', 'actions.json')), 'not yet');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(today(home).routes.token.health, 1);
  // restarting keeps what was counted, and a stamp writes even when nothing changed
  const again = new UsageCounters(home, new Set(['health']), () => true);
  again.route('health', 'token');
  again.flush(true);
  const before = readActions(home);
  again.flush(true);
  assert.equal(Object.values(before.days)[0].routes.token.health, 2);
  assert.ok(JSON.parse(readFileSync(path.join(home, 'usage', 'actions.json'), 'utf8')).lastFlush);
});

test('every route has an area, and the bridge registers a handler for each usage route', () => {
  assert.deepEqual(Object.keys(ROUTE_AREAS).sort(), Object.keys(ROUTES).sort());
  const handled = new Set([...API_ROUTES, ...STORY_ROUTES].map((entry) => entry.route));
  assert.ok(handled.has(ROUTES.usageCount) && handled.has(ROUTES.storyUsageCount));
  for (const [name, action] of Object.entries(ACTIONS)) {
    assert.match(name, /^(panel|local|board|ext)\.[A-Za-z.]+$/);
    assert.ok(action.area);
  }
});

test('fix 2: after `usage clear` a running bridge does not write the cleared days back', () => {
  const home = tmp('home');
  let clock = Date.parse('2026-11-05T14:00:00.000Z');
  const now = () => new Date(clock);
  const counters = new UsageCounters(home, new Set(['health']), () => true, now, 30);
  counters.route('health', 'token');
  counters.actions({ 'board.tab.switch': 3 }, 'board');
  counters.flush();
  assert.equal(today(home).routes.token.health, 1);

  clearUsage(home);
  assert.ok(!existsSync(path.join(home, 'usage', 'actions.json')));
  // a count held in memory but not yet written is part of what was cleared; the next one starts fresh
  clock += 2000;
  counters.route('health', 'board');
  counters.flush();
  const after = today(home);
  assert.equal(after.routes.token, undefined, 'the old day is not back');
  assert.equal(after.ui.board, undefined);
  assert.equal(after.routes.board.health, 1);

  // a flush with nothing new after another clear writes no old days either
  clearUsage(home);
  counters.flush(true);
  assert.deepEqual(readActions(home).days, {});
});
