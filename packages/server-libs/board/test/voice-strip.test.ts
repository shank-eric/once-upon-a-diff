import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { registerRuns } from '@once-upon-a-diff/state/test/helpers';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Board, noPrWatcher } from '../src/board.ts';
import {
  forgetProbes,
  phoneReady,
  runVoiceCtl,
  type PhoneCommand,
} from '@once-upon-a-diff/adapters/larmor';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  NOW,
  checkoutOf,
  fakeLarmor,
  fullId,
  liveChild,
  registry,
} from '@once-upon-a-diff/state/test/board-fixtures';
import { ctl, etAt, sourceSaying } from './board-fixtures.ts';

test('the voice session is pinned above the columns, off every card, with its agents keeping theirs', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const [voice, other] = [liveChild(), liveChild()];
  after(() => [voice, other].forEach((child) => child.stop()));
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const checkout = checkoutOf('widgets', 'main');
  registry(
    sessions,
    voice.pid,
    { cwd: checkout, name: 'clarifi-f9', status: 'busy' },
    voice.procStart,
  );
  registry(sessions, other.pid, { cwd: checkout, name: 'plain-one' }, other.procStart);
  const twoDaysBack = new Date(Date.UTC(2026, 9, 24, 13, 0)); // 9:00 AM ET, 10/24
  registerRuns(
    home,
    { sid: sid(voice), name: 'helper-one', started: etAt(14, 50) },
    {
      sid: sid(voice),
      name: 'helper-two',
      started: etAt(14, 50),
      now: { state: 'waiting', at: etAt(14, 55), outcome: 'needs Eric: pick', notes: 'notes/x.md' },
    },
    {
      sid: sid(voice),
      name: 'helper-three',
      started: etAt(14, 50),
      now: { state: 'done', at: etAt(14, 56), outcome: 'done' },
    },
    {
      sid: sid(voice),
      name: 'helper-four',
      started: etAt(14, 50),
      now: { state: 'review', at: etAt(14, 57), outcome: 'story abc up, two chapters' },
    },
    // left behind more than a day ago: no longer counted
    {
      sid: sid(voice),
      name: 'helper-five',
      started: twoDaysBack,
      now: { state: 'review', at: twoDaysBack, outcome: 'story old' },
    },
    {
      sid: sid(voice),
      name: 'helper-six',
      started: twoDaysBack,
      now: { state: 'waiting', at: twoDaysBack, outcome: 'needs Eric: long ago' },
    },
    { sid: sid(other), name: 'not-the-voice', started: etAt(14, 50) },
  );
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    owner: process.pid,
    last_listen: 5,
    last_speak: 4,
  });
  writeFileSync(path.join(voiceDir, 'voice-session-name'), 'clarifi-f9\n');
  // what it said (each line at its latest state; another session's lines left out) and what you said since it first spoke
  const wall = (minutes: number) => NOW.getTime() / 1000 - minutes * 60;
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    [
      {
        id: 'm1',
        wall: wall(5),
        text: 'One sec, checking.',
        session_id: fullId(voice.pid),
        status: 'queued',
      },
      {
        id: 'm1',
        wall: wall(5),
        text: 'One sec, checking.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
      {
        id: 'm2',
        wall: wall(10),
        text: 'Not this one.',
        session_id: 'someone-else',
        status: 'spoken',
      },
      {
        // a later voice session: its lines, and the turns after it spoke, are not this session's
        id: 'm4',
        wall: wall(1),
        text: 'Nor this.',
        session_id: 'someone-else',
        status: 'spoken',
      },
      {
        id: 'm3',
        wall: wall(2),
        text: 'It is green.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(voiceDir, 'turns.jsonl'),
    [
      {
        type: 'turn',
        channel: 'mic',
        text: 'Before it spoke.',
        is_final: true,
        wall_clock: wall(9),
      },
      { type: 'turn', channel: 'mic', text: 'Is it green?', is_final: true, wall_clock: wall(3) },
      { type: 'turn', channel: 'mic', text: 'Is it', is_final: false, wall_clock: wall(3) },
      {
        type: 'turn',
        channel: 'mic',
        text: 'To the next one.',
        is_final: true,
        wall_clock: wall(0.5),
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  // its status line's copy: the voice card shows its context use, and the board the usage limits
  writeJson(path.join(home, 'statusline', `${fullId(voice.pid)}.json`), {
    at: NOW.getTime() / 1000 - 30,
    context: 37,
    rate_limits: { five_hour: { used_percentage: 91, resets_at: NOW.getTime() / 1000 + 3600 } },
  });
  const settings = { board_sessions_dir: sessions };
  const withVoice = {
    ...settings,
    board_larmor_dir: fakeLarmor(voiceDir),
  };
  writeJson(path.join(home, 'config.json'), withVoice);
  const make = () => {
    forgetProbes(); // each build asks voice_ctl itself, so it sees the files as they are now
    return new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
  };
  const data = await make().snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  assert.equal(
    cards.find((card) => card.id === fullId(voice.pid)),
    undefined,
    'not on a card',
  );
  assert.ok(
    cards.find((card) => card.id === fullId(other.pid)),
    'other sessions are',
  );
  assert.deepEqual(data.voice, {
    name: 'clarifi-f9',
    title: 'clarifi-f9',
    repo: 'acme/widgets',
    lane: 'acme/widgets',
    branch: 'main',
    status: 'working',
    since: data.voice?.since,
    agents: { running: 1, waiting: 1, review: 1 },
    session: fullId(voice.pid),
    can_focus: false,
    context: 37,
    lines: [
      { who: 'voice', text: 'One sec, checking.', at: wall(5) * 1000 },
      { who: 'you', text: 'Is it green?', at: wall(3) * 1000 },
      { who: 'voice', text: 'It is green.', at: wall(2) * 1000 },
    ],
  });
  assert.deepEqual(data.usage, {
    five_hour: { percent: 91, resets_at: new Date(NOW.getTime() + 3600 * 1000).toISOString() },
    seven_day: null,
    at: new Date(NOW.getTime() - 30 * 1000).toISOString(),
  });
  // its agents keep their own cards, still "from" the voice session
  const helper = cards.find((card) => card.id === `agent:${sid(voice)}:helper-two`);
  assert.equal(helper?.column, 'waiting');
  assert.equal(helper?.parent, 'Voice session', 'named for what it is, not its tab title');
  assert.equal(helper?.lane, 'acme/widgets', 'in its parent’s lane');
  assert.equal(
    cards.find((card) => card.id === `agent:${sid(voice)}:helper-one`)?.lane,
    'acme/widgets',
    'no lane tag: its parent’s lane',
  );
  // with the setting unset, voice mode is not looked at: the session is a card like any other
  writeJson(path.join(home, 'config.json'), settings);
  const plain = await make().snapshot();
  assert.equal(plain.voice, null);
  assert.ok(
    plain.lanes.flatMap((lane) => lane.cards).find((card) => card.id === fullId(voice.pid)),
  );
  // and voice off in its own files: the same
  writeJson(path.join(home, 'config.json'), withVoice);
  writeJson(path.join(voiceDir, 'session'), { on: false, session_id: fullId(voice.pid) });
  assert.equal((await make().snapshot()).voice, null, 'voice is off and was never started today');
  // off, but it started today (last-voice.json, which outlives `session`'s id): the panel stays, as ended
  // (times are from the local midnight before NOW, so the case holds in any time zone)
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const lastVoice = (secondsAfterMidnight: number) =>
    writeJson(path.join(voiceDir, 'last-voice.json'), {
      session_id: fullId(voice.pid),
      cwd: '/x',
      at: midnight.getTime() / 1000 + secondsAfterMidnight,
    });
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  lastVoice(1);
  const ended = (await make().snapshot()).voice;
  assert.equal(ended?.status, 'ended');
  assert.equal(ended?.session, fullId(voice.pid));
  assert.equal(ended?.name, 'clarifi-f9');
  writeFileSync(path.join(voiceDir, 'paused'), '');
  assert.equal((await make().snapshot()).voice?.status, 'ended', 'ended wins over paused');
  // yesterday's voice is gone
  lastVoice(-3 * 24 * 3600);
  assert.equal((await make().snapshot()).voice, null);
  // voice on again and paused: the panel stays, as paused
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    owner: process.pid,
  });
  assert.equal((await make().snapshot()).voice?.status, 'paused');
});

test('voice on with no session id yet shows no strip, and the strip appears with the first status that has one', async () => {
  const home = tmp('board-voice-late-id');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const child = liveChild();
  after(() => child.stop());
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, child.pid, { status: 'idle' }, child.procStart);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_larmor_dir: fakeLarmor(voiceDir),
  });
  const snap = () => {
    forgetProbes();
    return new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    }).snapshot();
  };
  // on, its claim hook has not recorded the session yet: status says session_id null
  writeJson(path.join(voiceDir, 'session'), { on: true, owner: process.pid });
  assert.equal((await snap()).voice, null);
  assert.equal((await snap()).voice, null, 'asked again, still on with no id: nothing is kept');
  // the claim hook records it: the next status carries the id and the strip shows
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(child.pid),
    owner: process.pid,
  });
  const shown = (await snap()).voice;
  assert.equal(shown?.session, fullId(child.pid));
  assert.notEqual(shown?.status, 'ended');
});

test('the phone buttons need the checkout’s venv python and app/voice_ctl.py', () => {
  const larmor = fakeLarmor();
  assert.equal(phoneReady(larmor), true);
  rmSync(path.join(larmor, 'app', 'voice_ctl.py'));
  assert.equal(phoneReady(larmor), false, 'no script');
  assert.equal(phoneReady(tmp('board-no-larmor')), false);
});

test('runVoiceCtl runs only its fixed commands, from the checkout, and reads the last line it prints', async () => {
  const larmor = fakeLarmor();
  assert.throws(() => runVoiceCtl(larmor, 'bridge-start' as PhoneCommand), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'status', 'sess-1'), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'pause', 'sess-1'), /not an allowed/);
  // a session id goes to start alone, and only in an id's own shape
  assert.throws(() => runVoiceCtl(larmor, 'stop', 'sess-1'), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'start', '--help'), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'start', 'a b; rm'), /not an allowed/);
  assert.deepEqual(await runVoiceCtl(larmor, 'start', 'sess-1'), ctl({ voiceOn: true }));
  assert.deepEqual(await runVoiceCtl(larmor, 'stop'), ctl());
  rmSync(path.join(larmor, 'calls.log'));
  assert.deepEqual(await runVoiceCtl(larmor, 'phone-on'), ctl({ away: true, bridge: true }));
  assert.equal(readFileSync(path.join(larmor, 'calls.log'), 'utf8'), 'app/voice_ctl.py phone-on\n');
  writeFileSync(path.join(larmor, 'silent'), '');
  await assert.rejects(
    runVoiceCtl(larmor, 'bridge-stop'),
    /voice_ctl bridge-stop failed: ModuleNotFoundError: No module named 'rumps'/,
    'stderr’s last line is the reason',
  );
  await assert.rejects(
    runVoiceCtl(tmp('board-no-larmor'), 'phone-off'),
    /voice_ctl phone-off failed/,
  );
});

test('the phone state: null without a ready board_larmor_dir, else phone mode and the bridge from voice_ctl, with voice on or not', async () => {
  const home = tmp('board-voice-phone');
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
  const settings = {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  };
  const make = () => {
    forgetProbes(); // each build asks voice_ctl itself, so it sees the files as they are now
    return new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
  };
  writeJson(path.join(home, 'config.json'), settings);
  const noCheckout = await make().snapshot();
  assert.equal(noCheckout.phone, null, 'no checkout to ask');
  assert.equal(noCheckout.voice_start, null, 'nor to start voice with');
  const larmorDir = fakeLarmor(voiceDir);
  writeFileSync(path.join(larmorDir, 'bridge-up'), '');
  writeJson(path.join(home, 'config.json'), { ...settings, board_larmor_dir: larmorDir });
  forgetProbes();
  assert.deepEqual((await make().snapshot()).phone, { on: false, bridge: true });
  // Start voice: the live sessions with whether each is at its prompt, and the last voice session when it is still live
  const started = (await make().snapshot()).voice_start;
  assert.equal(started?.last, null, 'no last-voice.json yet');
  assert.deepEqual(
    started?.candidates.map((one) => [one.id, one.idle]),
    [[fullId(child.pid), true]],
  );
  writeJson(path.join(voiceDir, 'last-voice.json'), { session_id: fullId(child.pid), at: 1 });
  assert.equal((await make().snapshot()).voice_start?.last?.id, fullId(child.pid));
  writeJson(path.join(voiceDir, 'last-voice.json'), { session_id: 'gone-session', at: 1 });
  assert.equal(
    (await make().snapshot()).voice_start?.last,
    null,
    'a session that ended is not offered',
  );
  rmSync(path.join(voiceDir, 'last-voice.json'));
  writeJson(path.join(home, 'config.json'), {
    ...settings,
    board_larmor_dir: tmp('board-larmor-bare'),
  });
  assert.equal((await make().snapshot()).phone, null, 'no venv or voice_ctl there, no buttons');
  writeJson(path.join(home, 'config.json'), { ...settings, board_larmor_dir: larmorDir });
  writeJson(path.join(voiceDir, 'away'), { on: true, since: 1, by: 'phone' });
  assert.equal((await make().snapshot()).voice?.status, 'away');
  assert.deepEqual((await make().snapshot()).phone, { on: true, bridge: true });
  rmSync(path.join(larmorDir, 'bridge-up'));
  assert.deepEqual((await make().snapshot()).phone, { on: true, bridge: false });
  // voice_ctl failing: voice and the buttons are unknown, shown as off, and the board still builds
  writeFileSync(path.join(larmorDir, 'status.fail'), '');
  forgetProbes();
  const unknown = await make().snapshot();
  assert.equal(unknown.phone, null);
  assert.equal(unknown.voice, null);
  assert.equal(unknown.voice_paused, false);
  rmSync(path.join(larmorDir, 'status.fail'));
  forgetProbes();
  // the buttons do not depend on voice: with voice never started today there is no panel, and the phone state is there
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  const quiet = await make().snapshot();
  assert.equal(quiet.voice, null);
  assert.deepEqual(quiet.phone, { on: true, bridge: false });
});

test('the voice state: a pause file shows with voice off, only interactive sessions can take Start, and a dead owner means voice is off', async () => {
  const home = tmp('board-voice-facts');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const [shown, headless] = [liveChild(), liveChild()];
  after(() => {
    shown.stop();
    headless.stop();
  });
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, shown.pid, { status: 'idle', kind: 'interactive' }, shown.procStart);
  registry(sessions, headless.pid, { status: 'idle', kind: 'sdk-cli' }, headless.procStart);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_larmor_dir: fakeLarmor(voiceDir),
  });
  const snap = () => {
    forgetProbes(); // each build asks voice_ctl itself, so it sees the files as they are now
    return new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    }).snapshot();
  };
  assert.equal((await snap()).voice_paused, false);
  assert.deepEqual(
    (await snap()).voice_start?.candidates.map((one) => one.id),
    [fullId(shown.pid)],
    'a session that is not interactive is not offered',
  );
  // a pause left behind: voice has ended, and the page can still Resume (with no session file at all Larmor says paused is false)
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  writeFileSync(path.join(voiceDir, 'paused'), '');
  const left = await snap();
  assert.equal(left.voice, null);
  assert.equal(left.voice_paused, true);
  // voice on in a live owner, then the owner dies: the file still says on, Larmor counts it as off
  const owner = liveChild();
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(shown.pid),
    owner: owner.pid,
  });
  assert.equal((await snap()).voice?.status, 'paused');
  owner.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await snap()).voice, null, 'owner gone: voice is off');
});

test('Board.setVoicePaused asks voice_ctl and drops the kept snapshot, so the refresh right after Pause or Resume sees it', async () => {
  const home = tmp('board-voice-pause-cache');
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
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_larmor_dir: fakeLarmor(voiceDir),
  });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  assert.notEqual((await board.snapshot()).voice?.status, 'paused');
  await board.setVoicePaused(true);
  assert.equal((await board.snapshot()).voice?.status, 'paused');
  await board.setVoicePaused(false);
  assert.notEqual((await board.snapshot()).voice?.status, 'paused');
});
