import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, cpSync, writeFileSync } from 'node:fs';
import { tmp, writeJson } from './helpers.ts';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';

// Claude Code's session files are read with no promise their format holds: doctor and the board say so when files are
// there and none can be used, or the folder is gone.

const FIXTURES = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/adapters/fixtures/sessions/4242.json')),
);

function homeWith(sessions: string): string {
  const home = tmp('canary-home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  return home;
}
async function sessionLine(home: string): Promise<string> {
  const out: string[] = [];
  await doctor(home, { token: 't', port: 1 }, { out: (line) => out.push(line) });
  return out.find((one) => one.includes('Claude sessions:')) ?? '';
}
const warningOf = async (home: string) =>
  (
    await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: registrySource,
      now: () => new Date('2026-11-11T17:00:00Z'),
    }).snapshot()
  ).warning;

test('doctor: files that all have an unknown shape are a warning with the fix', async () => {
  const dir = tmp('canary-unknown');
  writeFileSync(path.join(dir, '101.json'), JSON.stringify({ pid: 101, id: 'x' }));
  writeFileSync(path.join(dir, '102.json'), JSON.stringify({ pid: 102, id: 'y' }));
  const line = await sessionLine(homeWith(dir));
  assert.match(line, /^WARN/);
  assert.match(line, /none could be used/);
});

test('doctor: a missing folder is reported as missing, not as no sessions', async () => {
  const line = await sessionLine(homeWith(path.join(tmp('canary-gone'), 'nope')));
  assert.match(line, /^WARN/);
  assert.match(line, /missing/);
});

test('doctor: the status hook is a warning pointing to the script until a status file exists', async () => {
  const home = homeWith(tmp('canary-hook-sessions'));
  const hookLine = async () => {
    const out: string[] = [];
    await doctor(home, { token: 't', port: 1 }, { out: (line) => out.push(line) });
    const index = out.findIndex((one) => one.includes('Status hook:'));
    return out.slice(index, index + 2).join('\n');
  };
  const bare = await hookLine();
  assert.match(bare, /^WARN/);
  assert.match(bare, /board-status\.sh/);
  writeJson(path.join(home, 'status', 'some-sess.json'), { state: 'done' });
  assert.match(await hookLine(), /^PASS/);
});

test('doctor: the recorded fixtures are quiet', async () => {
  const dir = tmp('canary-fixtures');
  cpSync(FIXTURES, dir, { recursive: true });
  assert.match(await sessionLine(homeWith(dir)), /^PASS/);
});

test('the board carries a notice when no session file could be used, and not for the fixtures', async () => {
  const bad = tmp('canary-board-bad');
  writeFileSync(path.join(bad, '101.json'), JSON.stringify({ pid: 101, id: 'x' }));
  assert.match((await warningOf(homeWith(bad))) ?? '', /once-upon doctor/);
  const good = tmp('canary-board-good');
  cpSync(FIXTURES, good, { recursive: true });
  assert.equal(await warningOf(homeWith(good)), null);
});

const TRUNCATED = '{"pid": 7, "sessionId": "x", "cw';

test('a truncated file beside good ones raises nothing, on the board or in doctor', async () => {
  const dir = tmp('canary-truncated-mixed');
  cpSync(FIXTURES, dir, { recursive: true });
  writeFileSync(path.join(dir, '7.json'), TRUNCATED);
  const line = await sessionLine(homeWith(dir));
  assert.match(line, /^PASS/);
  assert.match(line, /1 not valid JSON/);
  assert.equal(await warningOf(homeWith(dir)), null);
});

test('a truncated file alone raises no unknown-shape alarm', async () => {
  const dir = tmp('canary-truncated-alone');
  writeFileSync(path.join(dir, '7.json'), TRUNCATED);
  const line = await sessionLine(homeWith(dir));
  assert.match(line, /^PASS/);
  assert.doesNotMatch(line, /none could be used/);
  assert.equal(await warningOf(homeWith(dir)), null);
});

test('a parseable file with a dead pid among good ones raises nothing', async () => {
  const dir = tmp('canary-dead-pid');
  cpSync(FIXTURES, dir, { recursive: true });
  writeFileSync(
    path.join(dir, '2999999.json'),
    JSON.stringify({ pid: 2999999, sessionId: 'x', cwd: '/a' }),
  );
  assert.match(await sessionLine(homeWith(dir)), /^PASS/);
  assert.equal(await warningOf(homeWith(dir)), null);
});

test(
  'doctor: files that cannot be read are reported',
  { skip: process.getuid?.() === 0 && 'root reads everything' },
  async () => {
    const dir = tmp('canary-unreadable');
    const file = path.join(dir, '7.json');
    writeFileSync(file, JSON.stringify({ pid: 7, sessionId: 'x', cwd: '/a' }));
    chmodSync(file, 0o000);
    try {
      const line = await sessionLine(homeWith(dir));
      assert.match(line, /^WARN/);
      assert.match(line, /none could be read/);
    } finally {
      chmodSync(file, 0o600);
    }
  },
);
