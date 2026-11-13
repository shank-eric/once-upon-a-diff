import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Board, noPrWatcher } from '../src/board.ts';
import { voiceStatus } from '../src/voice.ts';
import {
  forgetProbes,
  STATUS_FRESH_MS,
  readVoice,
  voiceState,
  type CtlResult,
} from '@once-upon-a-diff/adapters/larmor';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { ctl, sourceSaying, until } from './board-fixtures.ts';
import {
  NOW,
  fakeLarmor,
  fullId,
  liveChild,
  pause,
  registry,
  withBoardWaits,
} from '@once-upon-a-diff/state/test/board-fixtures';

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

test('the voice session: voice_ctl says on, paused, away, the times, the name and the last session; nothing when voice is off', () => {
  assert.equal(readVoice(null), null, 'voice_ctl gave no answer');
  assert.equal(readVoice(ctl()), null, 'voice is off and never started today');
  const live = ctl({
    voiceOn: true,
    sessionId: 'abc12345-aaaa',
    lastListen: 1000000,
    lastSpeak: 990000,
  });
  assert.deepEqual(readVoice(live), {
    session: 'abc12345-aaaa',
    on: true,
    name: null,
    away: false,
    phoneOn: false,
    paused: false,
    lastListen: 1000000,
    lastSpeak: 990000,
  });
  assert.equal(
    readVoice(ctl({ voiceOn: true }))?.on ?? false,
    false,
    'on with no session id yet is not pinned',
  );
  assert.equal(readVoice({ ...live, name: 'clarifi-f9' })?.name, 'clarifi-f9');
  const files = readVoice({ ...live, name: 'clarifi-f9' }) as NonNullable<
    ReturnType<typeof readVoice>
  >;
  const now = 1000000 + 5000;
  assert.equal(voiceStatus(files, false, now), 'listening', 'it asked last and nothing is busy');
  assert.equal(voiceStatus({ ...files, lastSpeak: 1004000 }, false, now), 'speaking');
  assert.equal(
    voiceStatus({ ...files, lastSpeak: 1004000 }, false, now + 60000),
    'listening',
    'idle and a while since it spoke',
  );
  assert.equal(voiceStatus({ ...files, lastSpeak: 1004000 }, true, now + 60000), 'working');
  assert.equal(voiceStatus(files, true, now), 'working', 'busy is working');
  assert.equal(voiceStatus({ ...files, on: false }, false, now), 'ended', 'ended wins over all');
  const paused = readVoice({ ...live, paused: true }) as typeof files;
  assert.equal(voiceStatus(paused, false, now), 'paused');
  assert.equal(
    voiceStatus(readVoice({ ...live, paused: true, away: true }) as typeof files, false, now),
    'paused',
    'paused wins over away, so Resume is offered',
  );
  assert.equal(voiceStatus(readVoice({ ...live, away: true }) as typeof files, false, now), 'away');
  // voice off, the last session today: remembered as ended, with the times of an ended voice at zero
  const ended = readVoice(
    ctl({
      name: 'clarifi-f9',
      lastListen: 5,
      since: Date.now(),
      lastVoice: { session: 'abc12345-aaaa', cwd: '/x', at: Date.now() },
    }),
  );
  assert.deepEqual(
    [ended?.session, ended?.on, ended?.name, ended?.lastListen],
    ['abc12345-aaaa', false, 'clarifi-f9', 0],
  );
});

test('the voice session counts as today by its last activity, at the local midnight edge, in any time zone', () => {
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const stamp = (offsetSeconds: number) => midnight.getTime() + offsetSeconds * 1000;
  const noon = midnight.getTime() + 12 * 3600 * 1000;
  const lastVoice = (started: number) => ({
    session: 'abc12345-aaaa',
    cwd: '/x',
    at: stamp(started),
  });
  // ended after midnight, started before it: today
  assert.equal(readVoice(ctl({ lastVoice: lastVoice(-3600), since: stamp(60) }), noon)?.on, false);
  // started and ended before midnight: yesterday's, gone
  assert.equal(readVoice(ctl({ lastVoice: lastVoice(-7200), since: stamp(-1) }), noon), null);
  // started just after midnight, ended later today
  assert.equal(
    readVoice(ctl({ lastVoice: lastVoice(1), since: stamp(3600) }), noon)?.session,
    'abc12345-aaaa',
  );
  // still on, started yesterday: on is always shown
  assert.equal(
    readVoice(
      ctl({ voiceOn: true, sessionId: 'abc12345-aaaa', lastVoice: lastVoice(-86400) }),
      noon,
    )?.on,
    true,
  );
  // tomorrow, with nothing since: gone
  assert.equal(
    readVoice(ctl({ lastVoice: lastVoice(1), since: stamp(3600) }), noon + 24 * 3600 * 1000),
    null,
  );
});

test('phone mode is voice_ctl’s away, and it is only “away” while voice is on', () => {
  const read = (extra: Partial<CtlResult>) =>
    readVoice(ctl({ voiceOn: true, sessionId: 'abc12345-aaaa', ...extra })) as NonNullable<
      ReturnType<typeof readVoice>
    >;
  assert.deepEqual([read({}).phoneOn, read({}).away], [false, false]);
  assert.deepEqual([read({ away: true }).phoneOn, read({ away: true }).away], [true, true]);
  const ended = readVoice(
    ctl({ away: true, lastVoice: { session: 'abc12345-aaaa', cwd: null, at: Date.now() } }),
  ) as NonNullable<ReturnType<typeof readVoice>>;
  assert.deepEqual(
    [ended.phoneOn, ended.away],
    [true, false],
    'voice ended: phone mode is voice_ctl’s, away is voice on',
  );
});

test('voiceState says what voice_ctl status says, as Larmor’s voice_state does, and null (voice unknown) when it cannot answer', async () => {
  const voiceDir = tmp('board-voice-state');
  const larmor = fakeLarmor(voiceDir);
  // off: no session file at all
  assert.deepEqual(await coldState(larmor), ctl());
  // Larmor's voice_state reads nothing but off without a readable session file, a leftover pause included
  writeFileSync(path.join(voiceDir, 'paused'), '');
  assert.deepEqual(await coldState(larmor), ctl(), 'no session file: paused is false too');
  writeFileSync(path.join(voiceDir, 'session'), 'junk');
  assert.deepEqual(await coldState(larmor), ctl(), 'a session file that is not JSON');
  // `on` counts only with an owner pid that is alive (a file with no owner is off)
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: 'abc12345-aaaa' });
  assert.deepEqual(await coldState(larmor), ctl({ paused: true }), 'no owner: voice is off');
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: 2 ** 22 + 1,
  });
  assert.equal((await coldState(larmor))?.voiceOn, false, 'a dead owner: voice is off');
  // on, paused, away, with the bridge up
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  writeJson(path.join(voiceDir, 'away'), { on: true });
  writeFileSync(path.join(larmor, 'bridge-up'), '');
  assert.deepEqual(
    await coldState(larmor),
    ctl({ voiceOn: true, sessionId: 'abc12345-aaaa', paused: true, away: true, bridge: true }),
  );
  // voice on but the session not recorded yet: a null session id
  writeJson(path.join(voiceDir, 'session'), { on: true, owner: process.pid });
  assert.equal((await coldState(larmor))?.sessionId, null);
  // a missing checkout, voice_ctl failing, bad output
  assert.equal(await coldState(tmp('board-no-larmor')), null, 'no binary');
  writeFileSync(path.join(larmor, 'status.fail'), '');
  assert.equal(await coldState(larmor), null, 'exit 3 with a traceback');
  rmSync(path.join(larmor, 'status.fail'));
  for (const text of ['', 'not json', '3', 'null', '{"ok": "yes"}', '[]']) {
    writeFileSync(path.join(larmor, 'status.raw'), text);
    assert.equal(await coldState(larmor), null, `bad output: ${text || '(empty)'}`);
  }
  forgetProbes();
});

test('a cold voiceState read of a slow fake voice_ctl waits for it, as a loaded machine needs, and the board’s own waits give up on it', async () => {
  const voiceDir = tmp('board-voice-late');
  const larmor = fakeLarmor(voiceDir);
  writeFileSync(path.join(larmor, 'status.late'), '1200');
  assert.deepEqual(
    await coldState(larmor),
    ctl(),
    'the fake took 1.2 s to answer: past the board’s second',
  );
  // the call's own kill is a wait too (3 s for the board)
  writeFileSync(path.join(larmor, 'status.late'), '3500');
  assert.deepEqual(await coldState(larmor), ctl(), 'and 3.5 s: past the board’s call timeout');
  await withBoardWaits(async () => {
    assert.equal(await coldState(larmor), null, 'the board’s own cold wait gives up on it');
  });
  forgetProbes();
});

test('voiceState carries the times, the name and the last session as voice_ctl status gives them', async () => {
  const voiceDir = tmp('board-voice-extras');
  const larmor = fakeLarmor(voiceDir);
  assert.deepEqual(await coldState(larmor), ctl(), 'no files: every extra is null');
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
    since: 100,
    last_listen: 1000,
    last_speak: 990,
  });
  writeFileSync(path.join(voiceDir, 'voice-session-name'), 'clarifi-f9\nsecond line\n');
  writeJson(path.join(voiceDir, 'last-voice.json'), {
    session_id: 'abc12345-aaaa',
    cwd: '/x',
    at: 50,
  });
  assert.deepEqual(
    await coldState(larmor),
    ctl({
      voiceOn: true,
      sessionId: 'abc12345-aaaa',
      since: 100000,
      lastListen: 1000000,
      lastSpeak: 990000,
      name: 'clarifi-f9',
      lastVoice: { session: 'abc12345-aaaa', cwd: '/x', at: 50000 },
    }),
  );
  // voice ended: since is the end, listen and speak are null, name and the last session stay
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 200 });
  assert.deepEqual(
    await coldState(larmor),
    ctl({
      since: 200000,
      name: 'clarifi-f9',
      lastVoice: { session: 'abc12345-aaaa', cwd: '/x', at: 50000 },
    }),
  );
  // a last voice with no time is unusable, and one with no session id is none
  writeJson(path.join(voiceDir, 'last-voice.json'), {
    session_id: 'abc12345-aaaa',
    cwd: '/x',
    at: null,
  });
  assert.equal((await coldState(larmor))?.lastVoice, null);
  writeJson(path.join(voiceDir, 'last-voice.json'), { cwd: '/x', at: 5 });
  assert.equal((await coldState(larmor))?.lastVoice, null);
  forgetProbes();
});

test('voiceState: a status call that started before the board forgot does not store what it saw', async () => {
  const voiceDir = tmp('board-voice-forget');
  const larmor = fakeLarmor(voiceDir);
  writeFileSync(path.join(larmor, 'status.slow'), '');
  forgetProbes();
  void voiceState(larmor); // reads voice off, then waits 0.8 s
  // once it has claimed the marker it has read the state
  await until(
    () => existsSync(path.join(larmor, 'status.slow')),
    (there) => !there,
  );
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: 'abc12345-aaaa',
    owner: process.pid,
  });
  forgetProbes(); // after a command whose result is unknown
  const fresh = await until(
    () => voiceState(larmor),
    (state) => !!state,
  );
  assert.equal(fresh?.voiceOn, true, 'the next build asks again');
  await pause(1500); // the old call arrives, with what it read before
  assert.equal((await voiceState(larmor))?.voiceOn, true, 'and its old answer was dropped');
  forgetProbes();
});

test('a hung voice_ctl never holds up the board: the last answer is served, one call is in flight, and the failure is stamped when it ends', async () => {
  const home = tmp('board-voice-hung');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const child = liveChild();
  after(() => child.stop());
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, child.pid, { status: 'idle' }, child.procStart);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(child.pid),
    owner: process.pid,
  });
  const larmor = fakeLarmor(voiceDir);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_larmor_dir: larmor,
  });
  const timed = async () => {
    const began = Date.now();
    const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    }).snapshot();
    return { data, ms: Date.now() - began };
  };
  forgetProbes();
  assert.equal((await timed()).data.voice?.session, fullId(child.pid), 'warm: voice is there');
  // the hung part is the board's own 3 s call kill
  await withBoardWaits(async () => {
    writeFileSync(path.join(larmor, 'status.hang'), '');
    await pause(STATUS_FRESH_MS + 100);
    const calls = statusCalls(larmor);
    const [first, second] = [await timed(), await timed()];
    for (const one of [first, second]) {
      assert.ok(one.ms < 1000, `served in ${one.ms} ms, not after the 3 s limit`);
      assert.equal(one.data.voice?.session, fullId(child.pid), 'the last known voice state');
    }
    await until(
      () => statusCalls(larmor),
      (count) => count > calls,
    );
    await pause(300); // a second call, if there were one, would have started by now
    assert.equal(statusCalls(larmor), calls + 1, 'one refresh in flight for both builds');
    // the hung call is killed at its limit, and then voice is unknown
    const later = await until(timed, (one) => one.data.voice === null);
    assert.ok(later.ms < 1000);
    assert.equal(later.data.voice, null, 'unknown once the call failed');
    assert.equal(statusCalls(larmor), calls + 1, 'and not asked again for a while');
  });
  forgetProbes();
});
