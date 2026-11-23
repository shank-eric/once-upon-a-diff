import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { onBackgroundChange } from '@once-upon-a-diff/adapters/change-signal';
import {
  forgetProbes,
  setVoiceWaits,
  voiceLines,
  voiceState,
  STATUS_FRESH_MS,
} from '@once-upon-a-diff/adapters/larmor';
import { WIDE_WAITS, fakeLarmor, pause } from '@once-upon-a-diff/state/test/board-fixtures';
import { until } from './board-fixtures.ts';

const spokenLine = (id: string, wall: number, text: string, session: string) =>
  JSON.stringify({ id, wall, text, session_id: session, status: 'queued' }) + '\n';

/** A fake voice_ctl with one spoken line for the session; `say` adds another. */
function larmorWithLine(session: string) {
  const voiceDir = tmp('board-voice-fresh');
  const larmor = fakeLarmor(voiceDir);
  const now = Date.now() / 1000;
  const file = path.join(voiceDir, 'spoken.jsonl');
  writeFileSync(file, spokenLine('m1', now - 30, 'One sec.', session));
  let said = spokenLine('m1', now - 30, 'One sec.', session);
  return {
    larmor,
    voiceDir,
    say: (text: string) => {
      said += spokenLine(`m${said.length}`, Date.now() / 1000, text, session);
      writeFileSync(file, said);
    },
  };
}

const texts = (lines: { text: string }[]) => lines.map((line) => line.text);

test('voiceLines with voice on: stale lines are refreshed inside the build, so a line just spoken shows on this poll', async () => {
  const session = 'abc12345-aaaa';
  const { larmor, say } = larmorWithLine(session);
  forgetProbes();
  let told = 0;
  const stop = onBackgroundChange(() => (told += 1));
  try {
    assert.deepEqual(texts(await voiceLines(larmor, session, true)), ['One sec.']);
    say('It is green.');
    await pause(STATUS_FRESH_MS + 100);
    setVoiceWaits({ ...WIDE_WAITS, freshWaitMs: 30 * 1000 }); // the fake is a node process: its start may pass 250 ms under load
    assert.deepEqual(
      texts(await voiceLines(larmor, session, true)),
      ['One sec.', 'It is green.'],
      'this very build has the new line, not the next',
    );
    await pause(300);
    assert.equal(told, 0, 'a build that took the lines itself needs no second snapshot');
  } finally {
    setVoiceWaits(WIDE_WAITS);
    stop();
    forgetProbes();
  }
});

test('voiceLines with voice on: a refresh slower than the wait goes on with the kept lines, and its news drops the board snapshot', async () => {
  const session = 'abc12345-bbbb';
  const { larmor, say } = larmorWithLine(session);
  forgetProbes();
  let told = 0;
  const stop = onBackgroundChange(() => (told += 1));
  try {
    assert.deepEqual(texts(await voiceLines(larmor, session, true)), ['One sec.']);
    say('It is green.');
    await pause(STATUS_FRESH_MS + 100);
    setVoiceWaits({ ...WIDE_WAITS, freshWaitMs: 1 });
    assert.deepEqual(
      texts(await voiceLines(larmor, session, true)),
      ['One sec.'],
      'the wait ran out',
    );
    const told1 = await until(
      () => told,
      (count) => count > 0,
    );
    assert.equal(told1, 1, 'the late answer announced itself');
    assert.deepEqual(texts(await voiceLines(larmor, session, true)), ['One sec.', 'It is green.']);
  } finally {
    setVoiceWaits(WIDE_WAITS);
    stop();
    forgetProbes();
  }
});

test('voiceState: a refresh that finds a different state tells the board, and an unchanged one does not', async () => {
  const voiceDir = tmp('board-voice-state-news');
  const larmor = fakeLarmor(voiceDir);
  forgetProbes();
  let told = 0;
  const stop = onBackgroundChange(() => (told += 1));
  try {
    assert.equal((await voiceState(larmor))?.voiceOn, false);
    await pause(STATUS_FRESH_MS + 100);
    await voiceState(larmor); // the refresh: the same answer
    await pause(1000);
    assert.equal(told, 0, 'nothing changed');
    writeJson(path.join(voiceDir, 'session'), {
      on: true,
      session_id: 'abc12345-aaaa',
      owner: process.pid,
    });
    await pause(STATUS_FRESH_MS + 100);
    await voiceState(larmor); // the refresh that sees voice on
    await until(
      () => told,
      (count) => count > 0,
    );
    assert.equal(told, 1);
    assert.equal((await voiceState(larmor))?.voiceOn, true);
  } finally {
    stop();
    forgetProbes();
  }
});
