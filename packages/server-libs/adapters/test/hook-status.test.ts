import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import type { LiveSession } from '../src/claude-sessions/live-sessions.ts';
import { readHookStatuses, sweepHookStatuses } from '../src/claude-sessions/hook-status.ts';

const NOW = Date.parse('2026-11-16T18:00:00Z');
const LIVE = '11111111-aaaa-bbbb-cccc-dddddddddddd';
const GONE = '33333333-aaaa-bbbb-cccc-dddddddddddd';

const session = (id: string, status: string, statusAt: number | null): LiveSession => ({
  pid: 1,
  session: id,
  cwd: '/x',
  name: null,
  tty: null,
  status,
  statusAt,
  startedAt: null,
});

function put(home: string, id: string, file: unknown): string {
  const target = path.join(home, 'status', `${id}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof file === 'string' ? file : JSON.stringify(file));
  return target;
}
const hook = (state: string, stamp: number, detail: string | null = null) => ({
  session_id: LIVE,
  at: stamp,
  state,
  detail,
  event: 'x',
});

test('a live session with a fresh waiting file is Waiting, with the hook’s detail', () => {
  const home = tmp('hook-status');
  put(home, LIVE, hook('waiting', NOW, 'Ship it?'));
  const found = readHookStatuses(home, [session(LIVE, 'busy', NOW - 60_000)]);
  assert.deepEqual(found.get(LIVE), {
    status: 'waiting',
    detail: 'Ship it?',
  });
});

test('a waiting file from before the registry’s last change is old; within the skew it stands', () => {
  const home = tmp('hook-status-old');
  put(home, LIVE, hook('waiting', NOW - 60_000));
  assert.equal(readHookStatuses(home, [session(LIVE, 'busy', NOW)]).size, 0);
  assert.equal(readHookStatuses(home, [session(LIVE, 'idle', NOW - 57_000)]).size, 1);
  assert.equal(readHookStatuses(home, [session(LIVE, 'busy', null)]).size, 1);
});

test('done stands only while the registry is not busy; working is never read', () => {
  const home = tmp('hook-status-done');
  put(home, LIVE, hook('done', NOW));
  assert.equal(readHookStatuses(home, [session(LIVE, 'idle', NOW)]).get(LIVE)?.status, 'done');
  assert.equal(readHookStatuses(home, [session(LIVE, 'busy', NOW - 10_000)]).size, 0);
  put(home, LIVE, hook('working', NOW));
  assert.equal(readHookStatuses(home, [session(LIVE, 'idle', NOW)]).size, 0);
});

test('a gone session, broken JSON, an odd state and no folder give nothing', () => {
  const home = tmp('hook-status-odd');
  put(home, GONE, { ...hook('waiting', NOW), session_id: GONE });
  put(home, LIVE, '{not json');
  assert.equal(readHookStatuses(home, [session(LIVE, 'busy', NOW)]).size, 0);
  put(home, LIVE, hook('sleeping', NOW));
  assert.equal(readHookStatuses(home, [session(LIVE, 'busy', NOW)]).size, 0);
  assert.equal(readHookStatuses(path.join(home, 'nope'), [session(LIVE, 'idle', NOW)]).size, 0);
});

test('the sweep removes a gone, day-old file and keeps a live or young one', async () => {
  const home = tmp('hook-status-sweep');
  const old = put(home, GONE, hook('waiting', NOW));
  const young = put(home, '44444444-aaaa-bbbb-cccc-dddddddddddd', hook('done', NOW));
  const live = put(home, LIVE, hook('done', NOW));
  const longAgo = new Date(NOW - 2 * 24 * 3600 * 1000);
  utimesSync(old, longAgo, longAgo);
  utimesSync(live, longAgo, longAgo);
  const removed = await sweepHookStatuses(home, async () => new Set([LIVE]), NOW);
  assert.deepEqual(removed, [`${GONE}.json`]);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(live), true);
});
