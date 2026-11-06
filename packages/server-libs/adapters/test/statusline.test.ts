import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { readStatusLines, sweepStatusLines } from '../src/claude-sessions/statusline.ts';

const NOW = Date.parse('2026-10-28T18:00:00Z');
const LIVE = '11111111-aaaa-bbbb-cccc-dddddddddddd';
const OTHER = '22222222-aaaa-bbbb-cccc-dddddddddddd';
const GONE = '33333333-aaaa-bbbb-cccc-dddddddddddd';

function put(home: string, id: string, line: unknown): string {
  const file = path.join(home, 'statusline', `${id}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof line === 'string' ? line : JSON.stringify(line));
  return file;
}
const limits = (five: number, week: number) => ({
  five_hour: { used_percentage: five, resets_at: NOW / 1000 + 3600 },
  seven_day: { used_percentage: week, resets_at: NOW / 1000 + 86400 },
});

test('each live session’s context, and the freshest usage', () => {
  const home = tmp('statusline');
  put(home, LIVE, { at: NOW / 1000 - 60, context: 44.6, rate_limits: limits(91.2, 63) });
  put(home, OTHER, { at: NOW / 1000 - 600, context: 12, rate_limits: limits(80, 60) });
  const read = readStatusLines(home, new Set([LIVE, OTHER]), NOW);
  assert.deepEqual(Object.fromEntries(read.context), { [LIVE]: 45, [OTHER]: 12 });
  assert.deepEqual(read.usage, {
    five_hour: { percent: 91, resets_at: '2026-10-28T19:00:00.000Z' },
    seven_day: { percent: 63, resets_at: '2026-10-29T18:00:00.000Z' },
    at: '2026-10-28T17:59:00.000Z',
  });
});

test('no folder, a broken file, no limits or stale limits: no usage; reading removes nothing', () => {
  assert.deepEqual(readStatusLines(tmp('statusline-none'), new Set([LIVE]), NOW), {
    context: new Map(),
    usage: null,
  });
  const home = tmp('statusline-odd');
  put(home, LIVE, '{"at": ');
  put(home, OTHER, { at: NOW / 1000 - 7 * 3600, context: 20, rate_limits: limits(10, 10) });
  const gone = put(home, GONE, { at: NOW / 1000 - 3 * 86400, context: 5 });
  utimesSync(gone, new Date(NOW - 2 * 86400 * 1000), new Date(NOW - 2 * 86400 * 1000));
  const fresh = put(home, '44444444-aaaa-bbbb-cccc-dddddddddddd', { at: NOW / 1000, context: 5 });
  utimesSync(fresh, new Date(NOW), new Date(NOW));
  const read = readStatusLines(home, new Set([LIVE, OTHER]), NOW);
  assert.deepEqual(Object.fromEntries(read.context), { [OTHER]: 20 });
  assert.equal(read.usage, null, 'six hours old is stale');
  assert.equal(existsSync(gone), true, 'a read leaves a gone session’s day-old file alone');
  assert.equal(existsSync(fresh), true);
});

test('the sweep removes a gone session’s day-old file, and looks at the sessions only when one is that old', async () => {
  const home = tmp('statusline-sweep');
  const old = new Date(NOW - 2 * 86400 * 1000);
  const goneFile = put(home, GONE, { at: NOW / 1000 - 3 * 86400, context: 5 });
  utimesSync(goneFile, old, old);
  const liveFile = put(home, LIVE, { at: NOW / 1000 - 3 * 86400, context: 5 });
  utimesSync(liveFile, old, old);
  const fresh = put(home, OTHER, { at: NOW / 1000, context: 5 });
  utimesSync(fresh, new Date(NOW), new Date(NOW));
  assert.deepEqual(await sweepStatusLines(home, async () => new Set([LIVE]), NOW), [
    `${GONE}.json`,
  ]);
  assert.equal(existsSync(goneFile), false);
  assert.equal(existsSync(liveFile), true, 'a live session’s old file stays');
  assert.equal(existsSync(fresh), true, 'a recent file stays');
  let asked = 0;
  const none = await sweepStatusLines(
    home,
    async () => {
      asked += 1;
      return new Set<string>();
    },
    NOW - 2 * 86400 * 1000,
  );
  assert.deepEqual(none, []);
  assert.equal(asked, 0, 'nothing a day old: the sessions are not looked at');
  assert.deepEqual(
    await sweepStatusLines(tmp('statusline-no-folder'), async () => new Set(), NOW),
    [],
  );
});
