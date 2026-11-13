import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { forgetProbes, voiceLines, STATUS_FRESH_MS } from '@once-upon-a-diff/adapters/larmor';
import { fakeLarmor, pause, withBoardWaits } from '@once-upon-a-diff/state/test/board-fixtures';
import { until } from './board-fixtures.ts';

/** A spoken.jsonl line, as Larmor writes one per state of a reply. */
const spokenLine = (id: string, wall: number, text: string, session: string, status = 'queued') =>
  JSON.stringify({ id, wall, text, session_id: session, status }) + '\n';

const logCalls = (larmor: string) =>
  existsSync(path.join(larmor, 'log.log'))
    ? readFileSync(path.join(larmor, 'log.log'), 'utf8').trim().split('\n')
    : [];

test('voiceLines: once voice is off the log is fetched once and then left alone until voice is on again', async () => {
  const voiceDir = tmp('board-voice-log-off');
  const larmor = fakeLarmor(voiceDir);
  const session = 'abc12345-aaaa';
  const now = Date.now() / 1000;
  writeFileSync(path.join(voiceDir, 'spoken.jsonl'), spokenLine('m1', now - 60, 'One.', session));
  forgetProbes();
  assert.equal((await voiceLines(larmor, session, true)).length, 1);
  assert.equal(logCalls(larmor).length, 1);
  // voice ends: one more call, and that is all
  await pause(STATUS_FRESH_MS + 100);
  await voiceLines(larmor, session, false);
  await until(
    () => logCalls(larmor).length,
    (count) => count >= 2,
  );
  await pause(STATUS_FRESH_MS + 300);
  await voiceLines(larmor, session, false);
  await pause(STATUS_FRESH_MS + 300);
  assert.equal((await voiceLines(larmor, session, false)).length, 1, 'the lines are still shown');
  assert.equal(logCalls(larmor).length, 2, 'no more calls while voice stays off');
  // voice is on again: polls resume
  await voiceLines(larmor, session, true);
  await until(
    () => logCalls(larmor).length,
    (count) => count >= 3,
  );
  forgetProbes();
});

test('voiceLines keeps its lines when voice_ctl log fails, and a hung one holds a build for a second at most', async () => {
  const voiceDir = tmp('board-voice-log-fail');
  const larmor = fakeLarmor(voiceDir);
  const session = 'abc12345-aaaa';
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', Date.now() / 1000 - 30, 'One sec.', session),
  );
  forgetProbes();
  assert.equal((await voiceLines(larmor, session, true)).length, 1);
  writeFileSync(path.join(larmor, 'log.fail'), '');
  await pause(STATUS_FRESH_MS + 100);
  await voiceLines(larmor, session, true); // starts the refresh that fails
  await until(
    () => logCalls(larmor).length,
    (count) => count >= 2,
  );
  await pause(300);
  assert.equal((await voiceLines(larmor, session, true)).length, 1, 'the lines stay');
  // no lines yet and a hung log: the build goes on without them
  const hung = fakeLarmor(voiceDir);
  writeFileSync(path.join(hung, 'log.hang'), '');
  forgetProbes();
  await withBoardWaits(async () => {
    const began = Date.now();
    assert.deepEqual(await voiceLines(hung, session, true), []);
    assert.ok(Date.now() - began < 2500, `${Date.now() - began} ms`);
  });
  forgetProbes();
});
