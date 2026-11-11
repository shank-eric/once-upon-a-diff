import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import {
  liveRegistry,
  registryNotice,
  registryNote,
  registryProblem,
} from '../src/claude-sessions/live-sessions.ts';
import { BlankSessions } from '../src/claude-sessions/blank-sessions.ts';
import { projectFolder } from '../src/claude-sessions/transcripts.ts';
import { cpSync, mkdirSync } from 'node:fs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/claude-code');

test('the recorded registry files parse with nothing skipped, and say nothing is wrong', async () => {
  const { health } = await liveRegistry(path.join(FIXTURES, 'sessions'));
  assert.deepEqual(health, { folder: 'ok', seen: 3, skipped: 0, broken: 0, unreadable: 0 });
  assert.equal(registryProblem(health), null);
});

test('registry files that all have an unknown shape are reported, not read as no sessions', async () => {
  const dir = tmp('registry-unknown');
  // a renamed field: Claude Code's `sessionId` as `id`
  writeFileSync(path.join(dir, '101.json'), JSON.stringify({ pid: 101, id: 'x', cwd: '/a' }));
  writeFileSync(path.join(dir, '102.json'), JSON.stringify({ pid: 102, id: 'y' }));
  writeFileSync(path.join(dir, '103.json'), 'null');
  const { sessions, health } = await liveRegistry(dir);
  assert.deepEqual(sessions, []);
  assert.deepEqual(health, { folder: 'ok', seen: 3, skipped: 3, broken: 0, unreadable: 0 });
  assert.match(registryProblem(health) ?? '', /3 session files .* none could be used/);
  assert.match(registryNotice(health) ?? '', /once-upon doctor/);
});

test('some files skipped is a problem with a count, and a few good ones keep the rest', async () => {
  const dir = tmp('registry-some');
  cpSync(path.join(FIXTURES, 'sessions'), dir, { recursive: true });
  writeFileSync(path.join(dir, '9.json'), '[]');
  const { health } = await liveRegistry(dir);
  assert.deepEqual(health, { folder: 'ok', seen: 4, skipped: 1, broken: 0, unreadable: 0 });
  assert.match(registryProblem(health) ?? '', /1 of 4/);
});

test('a truncated file is broken, not an unknown shape, and raises no alarm beside good files or alone', async () => {
  const mixed = tmp('registry-truncated-mixed');
  cpSync(path.join(FIXTURES, 'sessions'), mixed, { recursive: true });
  writeFileSync(path.join(mixed, '7.json'), '{"pid": 7, "sessionId": "x", "cw');
  const one = await liveRegistry(mixed);
  assert.deepEqual(one.health, { folder: 'ok', seen: 4, skipped: 0, broken: 1, unreadable: 0 });
  assert.equal(registryProblem(one.health), null);
  assert.equal(registryNotice(one.health), null);
  assert.match(registryNote(one.health), /1 not valid JSON/);
  const alone = tmp('registry-truncated-alone');
  writeFileSync(path.join(alone, '7.json'), '{"pid": 7, "sessionId": "x", "cw');
  const { health } = await liveRegistry(alone);
  assert.deepEqual(health, { folder: 'ok', seen: 1, skipped: 0, broken: 1, unreadable: 0 });
  assert.equal(registryProblem(health), null);
  assert.equal(registryNotice(health), null);
});

test('a file caught half-written is read once more and counts when it has been finished', async () => {
  const dir = tmp('registry-midwrite');
  const file = path.join(dir, '7.json');
  writeFileSync(file, '{"pid": 7, "sessionId": "x", "cw');
  setTimeout(() => writeFileSync(file, JSON.stringify({ pid: 7, sessionId: 'x', cwd: '/a' })), 10);
  const { health } = await liveRegistry(dir);
  assert.deepEqual(health, { folder: 'ok', seen: 1, skipped: 0, broken: 0, unreadable: 0 });
});

test('a parseable file whose pid is gone is stale, not an unknown shape', async () => {
  const dir = tmp('registry-dead-pid');
  cpSync(path.join(FIXTURES, 'sessions'), dir, { recursive: true });
  writeFileSync(
    path.join(dir, '2999999.json'),
    JSON.stringify({ pid: 2999999, sessionId: 'x', cwd: '/a' }),
  );
  const { sessions, health } = await liveRegistry(dir);
  assert.equal(
    sessions.some((live) => live.pid === 2999999),
    false,
  );
  assert.deepEqual(health, { folder: 'ok', seen: 4, skipped: 0, broken: 0, unreadable: 0 });
  assert.equal(registryProblem(health), null);
  assert.equal(registryNotice(health), null);
});

test(
  'a file that cannot be read is counted as unreadable, and all of them is a problem',
  { skip: process.getuid?.() === 0 && 'root reads everything' },
  async () => {
    const dir = tmp('registry-unreadable');
    const file = path.join(dir, '7.json');
    writeFileSync(file, JSON.stringify({ pid: 7, sessionId: 'x', cwd: '/a' }));
    chmodSync(file, 0o000);
    try {
      const { health } = await liveRegistry(dir);
      assert.deepEqual(health, { folder: 'ok', seen: 1, skipped: 0, broken: 0, unreadable: 1 });
      assert.match(registryProblem(health) ?? '', /none could be read/);
      assert.equal(registryNotice(health), null);
    } finally {
      chmodSync(file, 0o600);
    }
  },
);

test('a missing folder is reported as missing, an empty one is fine', async () => {
  const base = tmp('registry-missing');
  const { sessions, health } = await liveRegistry(path.join(base, 'nope'));
  assert.deepEqual(sessions, []);
  assert.deepEqual(health, { folder: 'missing', seen: 0, skipped: 0, broken: 0, unreadable: 0 });
  assert.match(registryProblem(health) ?? '', /missing/);
  const empty = await liveRegistry(base);
  assert.deepEqual(empty.health, { folder: 'ok', seen: 0, skipped: 0, broken: 0, unreadable: 0 });
  assert.equal(registryProblem(empty.health), null);
});

test('the recorded cleared transcript is blank to the blank-session reader', async () => {
  const projects = tmp('registry-projects');
  const cwd = '/home/dev/projects/widgets';
  const id = '00000000-0000-4000-8000-000000000001';
  mkdirSync(path.join(projects, projectFolder(cwd)), { recursive: true });
  cpSync(
    path.join(FIXTURES, 'cleared-transcript.jsonl'),
    path.join(projects, projectFolder(cwd), `${id}.jsonl`),
  );
  assert.equal(await new BlankSessions().isBlank(projects, id, cwd, Date.now()), true);
});
