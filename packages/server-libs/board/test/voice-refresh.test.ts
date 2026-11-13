import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import {
  forgetProbes,
  rememberVoiceState,
  STATUS_FRESH_MS,
  voiceState,
} from '@once-upon-a-diff/adapters/larmor';
import { ctl, until } from './board-fixtures.ts';
import { fakeLarmor, pause, withBoardWaits } from '@once-upon-a-diff/state/test/board-fixtures';

/** How many times the fake voice_ctl was asked for status. */
const statusCalls = (larmor: string) =>
  existsSync(path.join(larmor, 'status.log'))
    ? readFileSync(path.join(larmor, 'status.log'), 'utf8').split('\n').length - 1
    : 0;

/** Voice state read cold: what the board forgets after a click, so the build asks voice_ctl itself. */
const coldState = (larmor: string) => {
  forgetProbes();
  return voiceState(larmor);
};

test('voiceState gives the last answer at once, refreshes it in the background one call at a time, and backs off after a failure', async () => {
  const voiceDir = tmp('board-voice-refresh');
  const larmor = fakeLarmor(voiceDir);
  assert.deepEqual(await coldState(larmor), ctl());
  assert.equal(statusCalls(larmor), 1);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  assert.equal(
    (await voiceState(larmor))?.voiceOn,
    false,
    'within a poll: the last answer, no call',
  );
  assert.equal(statusCalls(larmor), 1);
  await pause(STATUS_FRESH_MS + 100);
  // older than a poll: still the last answer now, and one refresh started, however many builds ask
  const asked = await Promise.all([voiceState(larmor), voiceState(larmor), voiceState(larmor)]);
  assert.ok(asked.every((one) => one?.voiceOn === false));
  const landed = await until(
    () => voiceState(larmor),
    (state) => state?.voiceOn === true,
  );
  assert.equal(landed?.voiceOn, true, 'the refresh landed');
  assert.equal(statusCalls(larmor), 2, 'one python for three readers');
  // a failure is stamped when its call ends, and is not asked again at the poll's pace
  writeFileSync(path.join(larmor, 'status.fail'), '');
  await pause(STATUS_FRESH_MS + 100);
  await voiceState(larmor); // starts the refresh that fails
  assert.equal(
    await until(
      () => voiceState(larmor),
      (state) => state === null,
    ),
    null,
    'unknown now',
  );
  const calls = statusCalls(larmor);
  await pause(STATUS_FRESH_MS + 300);
  assert.equal(await voiceState(larmor), null);
  assert.equal(statusCalls(larmor), calls, 'backing off: no new call at the poll’s pace');
  forgetProbes();
});

test('voiceState: a command’s own result is the new answer at once, and a call from before it is dropped', async () => {
  const voiceDir = tmp('board-voice-remember');
  const larmor = fakeLarmor(voiceDir);
  assert.equal((await coldState(larmor))?.voiceOn, false);
  writeFileSync(path.join(larmor, 'status.slow'), '');
  await pause(STATUS_FRESH_MS + 100);
  await voiceState(larmor); // the refresh starts, reads voice off and waits 0.8 s
  await until(
    () => existsSync(path.join(larmor, 'status.slow')),
    (there) => !there,
  );
  const calls = statusCalls(larmor);
  const result = ctl({ voiceOn: true, sessionId: 'abc12345-aaaa', paused: true });
  rememberVoiceState(larmor, result);
  assert.deepEqual(await voiceState(larmor), result, 'no wait, no call');
  assert.equal(statusCalls(larmor), calls);
  await pause(1500);
  assert.deepEqual(
    await voiceState(larmor),
    result,
    'the call from before arrived and was dropped',
  );
  forgetProbes();
});

test('with no answer yet, a hung voice_ctl holds a build for a second at most', async () => {
  const larmor = fakeLarmor(tmp('board-voice-cold-hang'));
  writeFileSync(path.join(larmor, 'status.hang'), '');
  await withBoardWaits(async () => {
    const began = Date.now();
    forgetProbes();
    assert.equal(await voiceState(larmor), null);
    assert.ok(Date.now() - began < 2500, `${Date.now() - began} ms`);
  });
  forgetProbes();
});
