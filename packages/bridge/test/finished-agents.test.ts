import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, startBridge, registerRuns, TOKEN, type TestBridge } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import { finishedColumn } from '@once-upon-a-diff/board/agent-home';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { lastActivity, ledgerTime } from '@once-upon-a-diff/state/records/agents/ledger';
import { appendLine } from '@once-upon-a-diff/adapters/stores/fs/lines';
import { BoardError } from '@once-upon-a-diff/foundation/errors';
import type { StatusSource } from '@once-upon-a-diff/adapters/status-source';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

// 3:40 PM ET on 11/2
const NOW = new Date('2026-11-02T20:40:00Z');
const MINUTE = 60000;
const SID = 'abcdef01';

const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
  encoding: 'utf8',
  env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
}).trim();

/** A board that mirrors into a ledger file, with a clock the test moves and one live session (the agents' parent). */
function world(config: Record<string, unknown> = {}) {
  const home = tmp('finished-home');
  const notes = tmp('finished-notes');
  const sessions = tmp('finished-sessions');
  const ledger = path.join(notes, 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: `${SID}-aaaa-bbbb-cccc-dddddddddddd`,
    cwd: '/tmp/finished/widgets',
    name: 'main-session',
    status: 'busy',
    startedAt: NOW.getTime() - 3600000,
    statusUpdatedAt: NOW.getTime() - 600000,
    procStart,
  });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    ...config,
  });
  const clock = { now: NOW };
  const source: StatusSource = {
    name: 'iterm',
    statuses: async (live) =>
      new Map(
        live.map((one) => [
          one.session,
          { status: 'working', detail: null, tasks: null, title: null },
        ]),
      ),
  };
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => clock.now,
    repoOf: async () => 'acme/widgets',
  });
  const cards = async (): Promise<BoardCard[]> =>
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .filter((one) => one.kind === 'agent');
  const card = async (name: string) =>
    (await cards()).find((one) => one.id === `agent:${SID}:${name}`);
  /** moves the clock to `minutes` after NOW (past the board's two-second cache) */
  const moveTo = (minutes: number) => {
    clock.now = new Date(NOW.getTime() + minutes * MINUTE);
  };
  return { home, ledger, board, cards, card, moveTo };
}

/** h:m PM ET on 11/2 (Eastern standard time, UTC-5). */
const pmET = (hour: number, minute: number) => new Date(Date.UTC(2026, 10, 2, hour + 17, minute));

/** A run of SID's that started five minutes before `when` and ended then: a helper unless `kind` says otherwise. */
const ended = (
  home: string,
  name: string,
  when: Date,
  outcome: string,
  state: 'done' | 'stopped' | 'failed' = 'done',
  extra: { kind?: 'research' | 'critic' | 'author'; notes?: string; sid?: string } = {},
) =>
  registerRuns(home, {
    sid: extra.sid ?? SID,
    name,
    kind: extra.kind,
    started: new Date(when.getTime() - 5 * MINUTE),
    now: { state, at: when, outcome, notes: extra.notes },
  });

test('the last thing an agent did is its latest event, else its end or its start', () => {
  const agent = ended(tmp('finished-last'), 'a', pmET(3, 20), 'ok').agents()[0];
  assert.equal(lastActivity(agent)?.toISOString(), '2026-11-02T20:20:00.000Z');
  assert.equal(
    lastActivity({ ended: null, started: new Date(NOW.getTime() - MINUTE) })?.toISOString(),
    new Date(NOW.getTime() - MINUTE).toISOString(),
  );
  assert.equal(lastActivity({ ended: null, started: null }), null);
});

test('ledger times are Eastern with their label, whatever zone the reader is set to', () => {
  assert.equal(ledgerTime(NOW), '3:40 PM ET, 11/2');
  assert.equal(ledgerTime(new Date('2026-11-02T05:05:00Z')), '12:05 AM ET, 11/2', 'midnight is 12');
});

test('appendLine starts a new line when the file does not end with one, and makes a missing file', () => {
  const file = path.join(tmp('append-line'), 'ledger.md');
  appendLine(file, 'one');
  writeFileSync(file, 'one\ntwo');
  appendLine(file, 'three');
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
});

test('a finished agent sits in Waiting with its outcome, notes and parent, then leaves 30 minutes after its last event', async () => {
  const rig = world();
  ended(rig.home, 'research-a', pmET(3, 20), 'options laid out', 'stopped', {
    notes: 'notes/research/a.md',
  });
  ended(rig.home, 'research-b', pmET(3, 25), 'the build broke', 'failed');
  ended(rig.home, 'research-c', pmET(3, 30), 'asked to stop', 'stopped');
  ended(rig.home, 'research-old', pmET(2, 0), 'long ago');
  const first = await rig.card('research-a');
  assert.ok(first, 'a card of its own');
  assert.equal(first.column, 'waiting');
  assert.equal(first.detail, 'options laid out');
  assert.equal(first.parent, 'main-session');
  assert.equal(first.agents[0].notes, 'notes/research/a.md');
  assert.equal(first.agents[0].clears_at, '2026-11-02T20:50:00.000Z');
  assert.equal(first.since, '2026-11-02T20:20:00.000Z');
  assert.equal((await rig.card('research-b'))?.column, 'waiting', 'failed too');
  assert.equal((await rig.card('research-c'))?.column, 'waiting', 'stopped too');
  assert.equal(await rig.card('research-old'), undefined, 'past its 30 minutes');
  rig.moveTo(11);
  assert.equal(await rig.card('research-a'), undefined, 'gone at 3:51 PM');
  assert.ok(await rig.card('research-b'), 'still there: it ended later');
  rig.moveTo(21);
  assert.equal(await rig.card('research-b'), undefined);
});

test('finishedColumn reads fields only: kind, state, result', () => {
  const column = (
    state: 'done' | 'stopped' | 'failed' | 'waiting',
    extra: Record<string, unknown> = {},
    name = 'ou-x',
  ) => finishedColumn({ name, state, ...extra });
  const result = { commit: 'abc1234' };
  // made something: a result, whatever the kind
  assert.equal(column('done', { kind: 'author', result }), 'done');
  assert.equal(column('done', { kind: 'author', result: { pr: 7 } }), 'done');
  assert.equal(column('done', { kind: 'research', result: { card: 'bl_x' } }), 'done');
  // no result: an author or an unknown kind waits, research is Research, a helper is Done
  assert.equal(column('done', { kind: 'author', result: null }), 'waiting');
  assert.equal(column('done', { kind: 'author', result: {} }), 'waiting', '{} is no result');
  assert.equal(column('done', { kind: null, result: null }), 'waiting', 'no kind: not research');
  assert.equal(column('done', { kind: 'research', result: null }), 'research');
  assert.equal(column('done', { kind: 'research', result: {} }), 'research');
  assert.equal(
    column('done', { kind: 'helper', result: null }),
    'done',
    'a plain helper did its job',
  );
  assert.equal(column('done', { kind: 'helper', result: {} }), 'done');
  // stopped: nothing to point at; a stopped research run lost nothing, other kinds were interrupted
  assert.equal(column('stopped', { kind: 'research' }), 'research');
  assert.equal(column('stopped', { kind: 'author' }), 'waiting');
  assert.equal(column('stopped', { kind: 'helper' }), 'waiting');
  assert.equal(
    column('stopped', { kind: 'research', result }),
    'research',
    'a stopped run made nothing',
  );
  assert.equal(column('stopped', { kind: 'author', result }), 'waiting');
  // failed is always Waiting; a reviewer is Done
  assert.equal(column('failed', { kind: 'research' }), 'waiting');
  assert.equal(column('failed', { kind: 'helper' }), 'waiting');
  assert.equal(column('failed', { kind: 'author', result }), 'waiting');
  assert.equal(column('done', { kind: 'critic', result: null }), 'done');
  assert.equal(column('stopped', { kind: 'critic' }), 'done');
  // a name is only a name: review- in it makes no critic
  assert.equal(column('stopped', { kind: 'helper' }, 'review-x'), 'waiting');
});

/** Registered agents (once-upon agent start/finish), at minutes from the test clock's NOW (3:40 PM ET). */
function register(home: string, name: string, kind: string, finish: object, atMinute = -10) {
  const registry = new AgentRegistry(home);
  const when = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
  registry.start({
    sid: SID,
    name,
    kind: kind as 'author',
    task: 'the task',
    repo: 'acme/widgets',
    at: when(atMinute - 5),
  });
  registry.finish(name, { outcome: 'what it did', at: when(atMinute), ...finish });
}

test('a finished research agent with no result is in Research for 30 minutes; a failed one, an explicit wait and one with a result are not', async () => {
  const rig = world();
  register(rig.home, 'ou-scout', 'research', {});
  register(rig.home, 'ou-scout-failed', 'research', { state: 'failed' });
  register(rig.home, 'ou-scout-stopped', 'research', { state: 'stopped' });
  register(rig.home, 'ou-scout-card', 'research', { result: { card: 'bl_mvzro4kube937c' } });
  const asker = new AgentRegistry(rig.home);
  asker.start({ sid: SID, name: 'ou-asker', kind: 'research', task: 'ask', at: NOW });
  asker.state('ou-asker', { state: 'waiting', outcome: 'pick A or B', at: NOW });
  const scout = await rig.card('ou-scout');
  assert.equal(scout?.column, 'research');
  assert.equal(scout?.detail, 'what it did');
  assert.equal(
    scout?.agents[0].clears_at,
    '2026-11-02T21:00:00.000Z',
    '30 minutes after its finish',
  );
  assert.equal((await rig.card('ou-scout-stopped'))?.column, 'research');
  assert.equal((await rig.card('ou-scout-failed'))?.column, 'waiting');
  assert.equal((await rig.card('ou-scout-card'))?.column, 'done');
  assert.equal((await rig.card('ou-asker'))?.column, 'waiting', 'a question stays a question');
  rig.moveTo(19);
  assert.ok(await rig.card('ou-scout'), 'at 29 minutes');
  rig.moveTo(21);
  assert.equal(await rig.card('ou-scout'), undefined, 'gone after 30 minutes');
});

test('Finish clears a Research card at once, and a later event brings it back', async () => {
  const rig = world();
  register(rig.home, 'ou-scout', 'research', {});
  assert.equal((await rig.card('ou-scout'))?.column, 'research');
  rig.moveTo(1);
  rig.board.finishAgent(SID, 'ou-scout');
  rig.moveTo(2);
  assert.equal(await rig.card('ou-scout'), undefined, 'cleared');
  const registry = new AgentRegistry(rig.home);
  registry.start({
    sid: SID,
    name: 'ou-scout',
    kind: 'research',
    task: 'again',
    at: new Date(NOW.getTime() + 3 * MINUTE),
  });
  registry.finish('ou-scout', { outcome: 'second look', at: new Date(NOW.getTime() + 4 * MINUTE) });
  rig.moveTo(5);
  const back = await rig.card('ou-scout');
  assert.equal(back?.column, 'research', 'back with a fresh timer');
  assert.equal(back?.agents[0].clears_at, '2026-11-02T21:14:00.000Z');
});

test('an author that finishes with no result is in Waiting and is gone after an hour; other finished cards still clear at 30 minutes', async () => {
  const rig = world();
  register(rig.home, 'ou-author', 'builder', {});
  register(rig.home, 'ou-author-stopped', 'builder', { state: 'stopped' });
  register(rig.home, 'ou-built', 'builder', { result: { card: 'bl_mvzro4kube937c' } });
  const author = await rig.card('ou-author');
  assert.equal(author?.column, 'waiting');
  assert.equal(author?.agents[0].clears_at, '2026-11-02T21:30:00.000Z', 'an hour after its finish');
  assert.equal((await rig.card('ou-author-stopped'))?.column, 'waiting');
  assert.equal((await rig.card('ou-built'))?.column, 'done');
  rig.moveTo(21);
  assert.equal(await rig.card('ou-built'), undefined, 'Done: 30 minutes');
  assert.ok(await rig.card('ou-author'), 'Waiting author: still there at 41 minutes');
  rig.moveTo(49);
  assert.ok(await rig.card('ou-author'), 'at 59 minutes');
  rig.moveTo(51);
  assert.equal(await rig.card('ou-author'), undefined, 'gone after an hour');
});

test('board_finished_wait_minutes sets how long a finished agent waits', async () => {
  const short = world({ board_finished_wait_minutes: 10 });
  ended(short.home, 'quick', pmET(3, 20), 'ok');
  assert.equal(await short.card('quick'), undefined, '20 minutes is past a 10-minute wait');
  const long = world({ board_finished_wait_minutes: 90 });
  ended(long.home, 'quick', pmET(3, 20), 'ok');
  assert.ok(await long.card('quick'));
  long.moveTo(60);
  assert.ok(await long.card('quick'), 'at 80 minutes of a 90-minute wait');
  long.moveTo(75);
  assert.equal(await long.card('quick'), undefined);
});

test('a later run resets the timer', async () => {
  const rig = world();
  ended(rig.home, 'by-run', pmET(3, 20), 'first');
  rig.moveTo(9);
  assert.equal((await rig.card('by-run'))?.agents[0].clears_at, '2026-11-02T20:50:00.000Z');
  ended(rig.home, 'by-run', pmET(3, 48), 'second look');
  rig.moveTo(12); // 3:52 PM, past the first window
  const again = await rig.card('by-run');
  assert.equal(
    again?.agents[0].clears_at,
    '2026-11-02T21:18:00.000Z',
    'a later run: a fresh 30 minutes',
  );
  assert.equal(again?.detail, 'second look');
});

test('one name used by two sessions is two agents: the old one stays gone while the new one waits', async () => {
  const rig = world();
  const other = 'deadbeef';
  ended(rig.home, 'review-x', pmET(2, 0), 'first pass', 'done', { kind: 'critic', sid: other });
  ended(rig.home, 'review-x', pmET(3, 30), 'second pass', 'done', { kind: 'critic' });
  const waiting = (await rig.cards()).filter((one) => one.title === 'review-x');
  assert.deepEqual(
    waiting.map((one) => one.id),
    [`agent:${SID}:review-x`],
  );
  assert.equal(waiting[0].detail, 'second pass');
});

test('Finish clears a finished agent’s card at once, writes no ledger line, and a later run brings it back', async () => {
  const rig = world();
  ended(rig.home, 'finisher', pmET(3, 20), 'result');
  const text = readFileSync(rig.ledger, 'utf8');
  assert.ok(await rig.card('finisher'));
  assert.deepEqual(rig.board.finishAgent(SID, 'finisher'), { ledger: false });
  assert.equal(await rig.card('finisher'), undefined, 'gone at once');
  assert.equal(readFileSync(rig.ledger, 'utf8'), text, 'a finished agent needs no new line');
  rig.moveTo(1);
  assert.equal(await rig.card('finisher'), undefined, 'still gone on the next look');
  ended(rig.home, 'finisher', pmET(3, 42), 'one more thing');
  rig.moveTo(3);
  const back = await rig.card('finisher');
  assert.equal(back?.detail, 'one more thing', 'it did something more');
  assert.equal(back?.agents[0].clears_at, '2026-11-02T21:12:00.000Z');
});

test('Finish on an agent waiting on a question writes its [done] line, and the card goes', async () => {
  const rig = world();
  registerRuns(rig.home, {
    sid: SID,
    name: 'asker',
    started: pmET(3, 25),
    now: { state: 'waiting', at: pmET(3, 30), outcome: 'needs Eric: pick A or B' },
  });
  const waiting = await rig.card('asker');
  assert.equal(waiting?.agents[0].state, 'waiting');
  assert.equal(waiting?.agents[0].clears_at, null, 'a question has no timer');
  assert.deepEqual(rig.board.finishAgent(SID, 'asker'), { ledger: true });
  assert.equal(
    readFileSync(rig.ledger, 'utf8').split('\n').at(-2),
    `- [done] sid:${SID} asker — 3:40 PM ET, 11/2 — finished from the board`,
    'the registry finishes it, and mirrors the line',
  );
  assert.equal(await rig.card('asker'), undefined);
  rig.moveTo(5);
  assert.equal(await rig.card('asker'), undefined, 'its own [done] line does not bring it back');
});

test('Finish refuses a working agent, one parked on your review, and one nobody registered', () => {
  const rig = world();
  registerRuns(
    rig.home,
    { sid: SID, name: 'busy', started: pmET(3, 30) },
    {
      sid: SID,
      name: 'parked',
      started: pmET(3, 25),
      now: { state: 'review', at: pmET(3, 30), outcome: 'story abc up' },
    },
  );
  const refuses = (name: string, status: number) =>
    assert.throws(
      () => rig.board.finishAgent(SID, name),
      (err: unknown) => err instanceof BoardError && err.status === status,
    );
  refuses('busy', 409);
  refuses('parked', 409);
  refuses('nobody', 404);
  assert.throws(
    () => world({ board_ledger_file: '' }).board.finishAgent(SID, 'x'),
    (err: unknown) => err instanceof BoardError && err.status === 404,
    'no ledger setting changes nothing',
  );
});

test('Finish still clears a card whose last event is ahead of the clock', async () => {
  const rig = world();
  // an event stamped 20 minutes after "now": another machine's clock
  ended(rig.home, 'ahead', pmET(4, 0), 'result');
  assert.ok(await rig.card('ahead'));
  rig.board.finishAgent(SID, 'ahead');
  assert.equal(await rig.card('ahead'), undefined);
  rig.moveTo(30);
  assert.equal(
    await rig.card('ahead'),
    undefined,
    'and it stays gone while nothing later is written',
  );
  ended(rig.home, 'ahead', pmET(4, 20), 'more');
  rig.moveTo(31);
  assert.equal((await rig.card('ahead'))?.detail, 'more', 'a later run brings it back');
});

test('POST /api/board/agent/finish takes the board key and a sid and name', async () => {
  const rig = world();
  ended(rig.home, 'routed', pmET(3, 20), 'result');
  const bridge = await startBridge({ home: rig.home });
  open.push(bridge);
  const post = (key: string, body: unknown) =>
    bridge.call<{ ok?: boolean; ledger?: boolean }>('POST', '/api/board/agent/finish', body, {
      Authorization: `Bearer ${key}`,
    });
  const key = boardKey(TOKEN);
  assert.equal((await post(key, {})).status, 400);
  assert.equal((await post(key, { sid: 'nothex', name: 'routed' })).status, 400);
  assert.equal((await post(key, { sid: SID, name: '../x' })).status, 400);
  assert.equal((await post(key, { sid: SID, name: 'nobody' })).status, 404);
  assert.equal((await post('a-wrong-key', { sid: SID, name: 'routed' })).status, 401);
  const done = await post(key, { sid: SID, name: 'routed' });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { ok: true, ledger: false });
});
