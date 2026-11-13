import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Board, noPrWatcher } from '../src/board.ts';
import {
  forgetProbes,
  rememberVoiceState,
  voiceLines,
  STATUS_FRESH_MS,
} from '@once-upon-a-diff/adapters/larmor';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { NOW, fakeLarmor, pause } from '@once-upon-a-diff/state/test/board-fixtures';
import { ctl, sourceSaying, until } from './board-fixtures.ts';

/** A spoken.jsonl line, as Larmor writes one per state of a reply. */
const spokenLine = (id: string, wall: number, text: string, session: string, status = 'queued') =>
  JSON.stringify({ id, wall, text, session_id: session, status }) + '\n';

const turnLine = (wall: number, text: string) =>
  JSON.stringify({ type: 'turn', channel: 'mic', text, is_final: true, wall_clock: wall }) + '\n';

const logCalls = (larmor: string) =>
  existsSync(path.join(larmor, 'log.log'))
    ? readFileSync(path.join(larmor, 'log.log'), 'utf8').trim().split('\n')
    : [];

test('voiceLines asks voice_ctl log, then re-reads the last few minutes in the background and merges by id', async () => {
  const voiceDir = tmp('board-voice-log');
  const larmor = fakeLarmor(voiceDir);
  const session = 'abc12345-aaaa';
  const now = Date.now() / 1000;
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', now - 3600, 'An hour ago.', session) +
      spokenLine('x1', now - 7200, 'Another session.', 'other-session') +
      spokenLine('m2', now - 30, 'One sec.', session),
  );
  writeFileSync(path.join(voiceDir, 'turns.jsonl'), turnLine(now - 20, 'Is it green?'));
  forgetProbes();
  const texts = (lines: { text: string }[]) => lines.map((line) => line.text);
  assert.deepEqual(texts(await voiceLines(larmor, session, true)), [
    'An hour ago.',
    'One sec.',
    'Is it green?',
  ]);
  assert.deepEqual(
    logCalls(larmor),
    [`--limit 60 --session ${session}`],
    'the first call asks for no time',
  );
  // the reply m2 gets its status changed under its first time, and a new one is said
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', now - 3600, 'An hour ago.', session) +
      spokenLine('x1', now - 7200, 'Another session.', 'other-session') +
      spokenLine('m2', now - 30, 'One sec.', session) +
      spokenLine('m2', now - 30, 'One sec.', session, 'spoken') +
      spokenLine('m3', now - 5, 'It is green.', session),
  );
  assert.deepEqual(
    texts(await voiceLines(larmor, session, true)).length,
    3,
    'within a poll: the last lines, no call',
  );
  assert.equal(logCalls(larmor).length, 1);
  await pause(STATUS_FRESH_MS + 100);
  await voiceLines(larmor, session, true); // the last lines now, and one refresh in the background
  const merged = await until(
    () => voiceLines(larmor, session, true),
    (lines) => lines.length === 4,
  );
  assert.deepEqual(
    texts(merged),
    ['An hour ago.', 'One sec.', 'Is it green?', 'It is green.'],
    'merged by id: m2 once, and the old line kept',
  );
  const second = logCalls(larmor)[1] ?? '';
  assert.match(
    second,
    /^--since \d+(\.\d+)? --limit 200 --session abc12345-aaaa$/,
    'later calls re-read a recent window',
  );
  assert.ok(
    Number(second.split(' ')[1]) > now - 400 && Number(second.split(' ')[1]) < now - 200,
    'about five minutes back, not from the last line seen',
  );
  assert.equal(logCalls(larmor).length, 2, 'one call for the refresh');
  forgetProbes();
});

test('voiceLines: a click while a log call runs does not freeze the lines, and later polls make new calls', async () => {
  const voiceDir = tmp('board-voice-log-click');
  const larmor = fakeLarmor(voiceDir);
  const session = 'abc12345-aaaa';
  const now = Date.now() / 1000;
  writeFileSync(path.join(voiceDir, 'spoken.jsonl'), spokenLine('m1', now - 60, 'One.', session));
  forgetProbes();
  assert.equal((await voiceLines(larmor, session, true)).length, 1);
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', now - 60, 'One.', session) + spokenLine('m2', now - 30, 'Two.', session),
  );
  writeFileSync(path.join(larmor, 'log.slow'), '');
  await pause(STATUS_FRESH_MS + 100);
  await voiceLines(larmor, session, true); // the refresh starts, and takes 0.8 s
  await until(
    () => logCalls(larmor).length,
    (count) => count >= 2,
  );
  rememberVoiceState(larmor, ctl()); // a click: the call in flight is from before it
  await pause(1500); // it ends
  // later polls make new calls, and the line it would have brought arrives
  const calls = logCalls(larmor).length;
  await pause(STATUS_FRESH_MS + 100);
  const lines = await until(
    () => voiceLines(larmor, session, true),
    (got) => got.length === 2,
  );
  assert.deepEqual(
    lines.map((line) => line.text),
    ['One.', 'Two.'],
  );
  assert.ok(logCalls(larmor).length > calls, 'a new call was made');
  forgetProbes();
});

test('voiceLines: after a gap of ten minutes the window still overlaps the last good call, so no line in between is lost', async () => {
  const voiceDir = tmp('board-voice-log-gap');
  const larmor = fakeLarmor(voiceDir);
  const session = 'abc12345-aaaa';
  const now = Date.now() / 1000;
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', now - 900, 'Long ago.', session),
  );
  forgetProbes();
  assert.equal((await voiceLines(larmor, session, true)).length, 1);
  // 15 minutes ago was the last line seen; one came 11 minutes ago, one a minute ago
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', now - 900, 'Long ago.', session) +
      spokenLine('m2', now - 660, 'In the gap.', session) +
      spokenLine('m3', now - 60, 'Just now.', session),
  );
  await pause(STATUS_FRESH_MS + 100);
  await voiceLines(larmor, session, true);
  const lines = await until(
    () => voiceLines(larmor, session, true),
    (got) => got.length === 3,
  );
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Long ago.', 'In the gap.', 'Just now.'],
  );
  const since = Number((logCalls(larmor)[1] ?? '').split(' ')[1]);
  assert.ok(
    since < now - 1100 && since > now - 1300,
    `since ${now - since} s back: five minutes before the last good call's newest line`,
  );
  assert.match(logCalls(larmor)[1] ?? '', /--limit 200 /, 'a refresh may bring up to 200 lines');
  forgetProbes();
});

test('the voice strip’s lines are asked for only when a session is pinned', async () => {
  const home = tmp('board-voice-nolog');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor(voiceDir);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'ghost-session-nobody-runs',
    owner: process.pid,
  });
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    spokenLine('m1', Date.now() / 1000, 'Hello.', 'ghost-session-nobody-runs'),
  );
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_larmor_dir: larmor,
  });
  forgetProbes();
  const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  }).snapshot();
  assert.equal(data.voice, null, 'its session is not running, so there is no strip');
  assert.deepEqual(logCalls(larmor), [], 'and voice_ctl log was not run');
});
