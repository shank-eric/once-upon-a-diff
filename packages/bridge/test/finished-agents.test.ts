import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { boardKey } from '../src/services/pages/page-key.ts';
import { finishedColumn } from '../src/services/board/agent-home.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';
import { doneLine, lastActivity, ledgerTime, parseLedger } from '../src/services/ledger/ledger.ts';
import { appendLine } from '../src/adapters/stores/fs/lines.ts';
import { BoardError } from '../src/services/errors.ts';
import type { StatusSource } from '../src/adapters/status-source.ts';
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

/** A board over a ledger and progress file, with a clock the test moves and one live session (the agents' parent). */
function world(config: Record<string, unknown> = {}) {
  const home = tmp('finished-home');
  const notes = tmp('finished-notes');
  const sessions = tmp('finished-sessions');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(ledger, '');
  writeFileSync(progress, '');
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
    board_progress_file: progress,
    board_sessions_dir: sessions,
    board_ledger_time_zone: 'America/New_York',
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
  return { home, ledger, progress, board, cards, card, moveTo };
}

const line = (state: string, name: string, time: string, rest: string) =>
  `- [${state}] sid:${SID} ${name} — ${time} — ${rest}\n`;

test('a ledger line names its notes file, and a later line without one keeps it', () => {
  const [one] = parseLedger(
    `- [done] sid:${SID} one — 3:20 PM ET, 11/2 — result in hand — notes/research/2026-11-02-one.md\n`,
    NOW,
  );
  assert.equal(one.notes, 'notes/research/2026-11-02-one.md');
  const [two] = parseLedger(
    `- [done] sid:${SID} two — result; ~/Development/ClariFi/notes/x.md. — 3:20 PM ET, 11/2\n`,
    NOW,
  );
  assert.equal(two.notes, '~/Development/ClariFi/notes/x.md');
  const [kept] = parseLedger(
    `- [running] sid:${SID} three (sonnet) — write notes/a.md — started 3:00 PM ET, 11/2\n- [done] sid:${SID} three — 3:20 PM ET, 11/2 — fine\n`,
    NOW,
  );
  assert.equal(kept.notes, 'notes/a.md');
  assert.equal(
    parseLedger(`- [done] sid:${SID} four — 3:20 PM ET, 11/2 — nothing\n`, NOW)[0].notes,
    null,
  );
});

test('the last thing an agent did is its latest ledger line’s time, else its start', () => {
  const agent = parseLedger(
    line('done', 'a', '3:20 PM ET, 11/2', 'ok'),
    NOW,
    'America/New_York',
  )[0];
  assert.equal(lastActivity(agent)?.toISOString(), '2026-11-02T20:20:00.000Z');
  assert.equal(
    lastActivity({ ended: null, started: new Date(NOW.getTime() - MINUTE) })?.toISOString(),
    new Date(NOW.getTime() - MINUTE).toISOString(),
  );
  assert.equal(lastActivity({ ended: null, started: null }), null);
});

test('the done line Finish writes is Eastern time with its label, whatever zone the reader is set to', () => {
  assert.equal(ledgerTime(NOW), '3:40 PM ET, 11/2');
  assert.equal(ledgerTime(new Date('2026-11-02T05:05:00Z')), '12:05 AM ET, 11/2', 'midnight is 12');
  const text = doneLine({ sid: SID, lane: 'widgets', name: 'asker' }, NOW);
  assert.match(
    text,
    /^- \[done\] sid:abcdef01 lane:widgets asker — 3:40 PM ET, 11\/2 — finished from the board$/,
  );
  for (const zone of ['America/Chicago', 'Asia/Tokyo', undefined]) {
    const [back] = parseLedger(text, NOW, zone);
    assert.deepEqual(
      [back.state, back.lane, back.ended?.toISOString(), back.outcome],
      ['done', 'widgets', NOW.toISOString(), 'finished from the board'],
      String(zone),
    );
  }
});

test('appendLine starts a new line when the file does not end with one, and makes a missing file', () => {
  const file = path.join(tmp('append-line'), 'ledger.md');
  appendLine(file, 'one');
  writeFileSync(file, 'one\ntwo');
  appendLine(file, 'three');
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
});

test('a finished agent sits in Waiting with its outcome, notes and parent, then leaves 30 minutes after its last line', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('stopped', 'research-a', '3:20 PM ET, 11/2', 'options laid out — notes/research/a.md') +
      line('failed', 'research-b', '3:25 PM ET, 11/2', 'the build broke') +
      line('stopped', 'research-c', '3:30 PM ET, 11/2', 'asked to stop') +
      line('done', 'research-old', '2:00 PM ET, 11/2', 'long ago'),
  );
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
  assert.ok(await rig.card('research-b'), 'still there: its line was later');
  rig.moveTo(21);
  assert.equal(await rig.card('research-b'), undefined);
});

const running = (name: string, task: string) =>
  `- [running] sid:${SID} ${name} (sonnet, low) — ${task} — started 3:00 PM ET, 11/2\n`;

test('an agent known only from the ledger is Done on its [done] line whatever the text says; a stopped or failed one, and one with no [done], is Waiting; a review- name is Done', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    running('ou-build', 'the board fix') +
      line('done', 'ou-build', '3:20 PM ET, 11/2', 'branch board-fix, sha 0637f8f, tests green') +
      // the words say it did nothing, and the line still says done: the text is not read
      running('ou-nothing', 'try it') +
      line('done', 'ou-nothing', '3:21 PM ET, 11/2', 'nothing was committed or pushed') +
      running('research-fees', 'compare the fee options') +
      line(
        'done',
        'research-fees',
        '3:25 PM ET, 11/2',
        'options laid out — notes/research/fees.md',
      ) +
      running('review-board-fix', 'review the diff') +
      line('stopped', 'review-board-fix', '3:24 PM ET, 11/2', '3 findings — notes/reviews/x.md') +
      running('ou-stopped', 'card bl_abc123def456 try it') +
      line('stopped', 'ou-stopped', '3:26 PM ET, 11/2', 'committed 0637f8f, then asked to stop') +
      running('ou-failed', 'card bl_abc123def456 try it') +
      line('failed', 'ou-failed', '3:27 PM ET, 11/2', 'deployed, then the build broke') +
      line('waiting', 'ou-asker', '3:28 PM ET, 11/2', 'needs Eric: pick A or B — notes/x.md'),
  );
  const columns: Record<string, string | undefined> = {};
  for (const name of [
    'ou-build',
    'ou-nothing',
    'research-fees',
    'review-board-fix',
    'ou-stopped',
    'ou-failed',
    'ou-asker',
  ]) {
    columns[name] = (await rig.card(name))?.column;
  }
  assert.deepEqual(columns, {
    'ou-build': 'done',
    'ou-nothing': 'done',
    'research-fees': 'done',
    'review-board-fix': 'done',
    'ou-stopped': 'waiting',
    'ou-failed': 'waiting',
    'ou-asker': 'waiting',
  });
  const built = await rig.card('ou-build');
  assert.equal(
    built?.agents[0].clears_at,
    '2026-11-02T20:50:00.000Z',
    'Done cards clear on the same timer',
  );
});

test('finishedColumn reads fields only: kind, state, result, ledger source', () => {
  const column = (
    state: 'done' | 'stopped' | 'failed' | 'waiting',
    extra: Record<string, unknown> = {},
    name = 'ou-x',
  ) => finishedColumn({ name, state, source: 'events', ...extra });
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
  // ledger only: no kind or result, so never Research
  assert.equal(finishedColumn({ name: 'review-x', state: 'stopped' }), 'done', 'a ledger reviewer');
  assert.equal(finishedColumn({ name: 'ou-x', state: 'done' }), 'done', 'a ledger [done]');
  assert.equal(finishedColumn({ name: 'ou-x', state: 'stopped' }), 'waiting');
  assert.equal(finishedColumn({ name: 'ou-x', state: 'waiting' }), 'waiting');
});

/** Registered agents (once-upon agent start/finish) beside the ledger, at minutes from the test clock's NOW (3:40 PM ET). */
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

test('a ledger [done] whose words say research stays Done: no text is read', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    `- [running] sid:${SID} ou-words (sonnet, low) — try it — started 3:00 PM ET, 11/2\n` +
      line('done', 'ou-words', '3:30 PM ET, 11/2', 'research only, nothing built'),
  );
  assert.equal((await rig.card('ou-words'))?.column, 'done');
});

test('board_finished_wait_minutes sets how long a finished agent waits', async () => {
  const text = line('done', 'quick', '3:20 PM ET, 11/2', 'ok');
  const short = world({ board_finished_wait_minutes: 10 });
  writeFileSync(short.ledger, text);
  assert.equal(await short.card('quick'), undefined, '20 minutes is past a 10-minute wait');
  const long = world({ board_finished_wait_minutes: 90 });
  writeFileSync(long.ledger, text);
  assert.ok(await long.card('quick'));
  long.moveTo(60);
  assert.ok(await long.card('quick'), 'at 80 minutes of a 90-minute wait');
  long.moveTo(75);
  assert.equal(await long.card('quick'), undefined);
});

test('a new ledger line resets the timer, and progress beats do not count', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('done', 'by-line', '3:20 PM ET, 11/2', 'first') +
      line('done', 'by-beat', '3:20 PM ET, 11/2', 'first'),
  );
  rig.moveTo(9);
  assert.equal((await rig.card('by-line'))?.agents[0].clears_at, '2026-11-02T20:50:00.000Z');
  appendFileSync(rig.ledger, line('done', 'by-line', '3:48 PM ET, 11/2', 'second look'));
  appendFileSync(rig.progress, '- 3:47 PM by-beat 6/6 done: more notes\n');
  rig.moveTo(12); // 3:52 PM, past the first window
  const byLine = await rig.card('by-line');
  assert.equal(
    byLine?.agents[0].clears_at,
    '2026-11-02T21:18:00.000Z',
    'a later line: a fresh 30 minutes',
  );
  assert.equal(byLine?.detail, 'second look');
  assert.equal(await rig.card('by-beat'), undefined, 'a beat has no date: it starts nothing');
});

test('an old agent does not come back because a beat from days ago has this time of day', async () => {
  const rig = world();
  writeFileSync(rig.ledger, line('done', 'last-week', '3:35 PM ET, 10/23', 'long finished'));
  // beat.sh writes a time of day only: 10/23's beat at 3:35 PM reads as today's 3:35 PM
  writeFileSync(rig.progress, '- 3:35 PM last-week 6/6 done: all green\n');
  assert.equal(await rig.card('last-week'), undefined);
  rig.moveTo(5);
  assert.equal(await rig.card('last-week'), undefined);
});

test('one name used by two sessions is two agents: the old one stays gone while the new one waits', async () => {
  const rig = world();
  const other = 'deadbeef';
  writeFileSync(
    rig.ledger,
    `- [done] sid:${other} review-x — 2:00 PM ET, 11/2 — first pass\n` +
      `- [done] sid:${SID} review-x — 3:30 PM ET, 11/2 — second pass\n`,
  );
  writeFileSync(rig.progress, '- 3:35 PM review-x 6/6 done: finished\n');
  const waiting = (await rig.cards()).filter((one) => one.title === 'review-x');
  assert.deepEqual(
    waiting.map((one) => one.id),
    [`agent:${SID}:review-x`],
  );
  assert.equal(waiting[0].detail, 'second pass');
});

test('Finish clears a finished agent’s card at once, writes no ledger line, and a later line brings it back', async () => {
  const rig = world();
  const text = line('done', 'finisher', '3:20 PM ET, 11/2', 'result');
  writeFileSync(rig.ledger, text);
  assert.ok(await rig.card('finisher'));
  assert.deepEqual(rig.board.finishAgent(SID, 'finisher'), { ledger: false });
  assert.equal(await rig.card('finisher'), undefined, 'gone at once');
  assert.equal(readFileSync(rig.ledger, 'utf8'), text, 'a finished agent needs no new line');
  rig.moveTo(1);
  assert.equal(await rig.card('finisher'), undefined, 'still gone on the next look');
  appendFileSync(rig.ledger, line('done', 'finisher', '3:42 PM ET, 11/2', 'one more thing'));
  rig.moveTo(3);
  const back = await rig.card('finisher');
  assert.equal(back?.detail, 'one more thing', 'it did something more');
  assert.equal(back?.agents[0].clears_at, '2026-11-02T21:12:00.000Z');
});

test('Finish on an agent waiting on a question writes its [done] line, and the card goes', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('waiting', 'asker', '3:30 PM ET, 11/2', 'needs Eric: pick A or B').trimEnd(),
  );
  const waiting = await rig.card('asker');
  assert.equal(waiting?.agents[0].state, 'waiting');
  assert.equal(waiting?.agents[0].clears_at, null, 'a question has no timer');
  assert.deepEqual(rig.board.finishAgent(SID, 'asker'), { ledger: true });
  assert.equal(
    readFileSync(rig.ledger, 'utf8').split('\n').at(-2),
    `- [done] sid:${SID} asker — 3:40 PM ET, 11/2 — finished from the board`,
  );
  assert.equal(await rig.card('asker'), undefined);
  rig.moveTo(5);
  assert.equal(await rig.card('asker'), undefined, 'its own [done] line does not bring it back');
});

test('Finish refuses a working agent, one parked on your review, and one the ledger does not have', () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    `- [running] sid:${SID} busy (sonnet, low) — a task — started 3:30 PM ET, 11/2\n` +
      line('review', 'parked', '3:30 PM ET, 11/2', 'story abc up'),
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
    (err: unknown) => err instanceof BoardError && err.status === 400,
  );
});

test('Finish still clears a card whose last line is ahead of the clock', async () => {
  const rig = world();
  // a line stamped 20 minutes after "now": a wrong zone label, or a typo
  writeFileSync(rig.ledger, line('done', 'ahead', '4:00 PM ET, 11/2', 'result'));
  assert.ok(await rig.card('ahead'));
  rig.board.finishAgent(SID, 'ahead');
  assert.equal(await rig.card('ahead'), undefined);
  rig.moveTo(30);
  assert.equal(
    await rig.card('ahead'),
    undefined,
    'and it stays gone while nothing later is written',
  );
  appendFileSync(rig.ledger, line('done', 'ahead', '4:20 PM ET, 11/2', 'more'));
  rig.moveTo(31);
  assert.equal((await rig.card('ahead'))?.detail, 'more', 'a later line brings it back');
});

test('POST /api/board/agent/finish takes the board key and a sid and name', async () => {
  const rig = world();
  writeFileSync(rig.ledger, line('done', 'routed', '3:20 PM ET, 11/2', 'result'));
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
