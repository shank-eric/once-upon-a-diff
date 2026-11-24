/*
 * What doctor --fix keeps of agents.jsonl (src/records/agents/compact.ts): a run over for good goes with all its lines, a run that
 * stays keeps its last beat, and the fold tells every run that stays what it told before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAgentEvents, parseAgentEvents } from '../src/records/agents/events.ts';
import {
  compactAgentLines,
  planAgentLines,
  type CardState,
} from '../src/records/agents/compact.ts';
import { recordedTips } from '../src/queues/backlog/landing.ts';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const CUTOFF = NOW - 14 * DAY;
const ago = (days: number, hours = 0) =>
  new Date(NOW - days * DAY + hours * 3600 * 1000).toISOString();

type Row = Record<string, unknown>;
const row = (kind: string, name: string, run: string, time: string, more: Row = {}): Row => ({
  op: kind,
  v: 1,
  id: `abcd1234:${name}`,
  sid8: 'abcd1234',
  name,
  run,
  at: time,
  ...more,
});
const start = (name: string, run: string, time: string, more: Row = {}) =>
  row('start', name, run, time, { kind: 'author', task: `task of ${name}`, ...more });
const beat = (name: string, run: string, time: string, count: number) =>
  row('beat', name, run, time, { n: count, of: 5, step: 'code', note: `beat ${count}` });
const finish = (name: string, run: string, time: string, state = 'done', more: Row = {}) =>
  row('finish', name, run, time, { state, outcome: 'ok', ...more });

const cards: Record<string, CardState> = { bl_done: 'closed', bl_open: 'open' };
const cardState = (card: string) => cards[card];
const textOf = (rows: Row[]) => rows.map((one) => JSON.stringify(one));
const compact = (rows: Row[]) => compactAgentLines(textOf(rows), CUTOFF, cardState);
const events = (lines: string[]) => parseAgentEvents(lines.join('\n'));
const names = (lines: string[]) => [...new Set(events(lines).map((event) => event.name))];

const world: Row[] = [
  // (i) old, finished, on a done card: goes whole
  start('old-done', 'r_0000000001', ago(30), { card: 'bl_done' }),
  beat('old-done', 'r_0000000001', ago(30, 1), 1),
  beat('old-done', 'r_0000000001', ago(30, 2), 2),
  finish('old-done', 'r_0000000001', ago(29), 'done', {
    result: { commit: 'abc1234', card: 'bl_done' },
  }),
  // (ii) old, finished, on an OPEN card: stays
  start('old-open', 'r_0000000002', ago(30), { card: 'bl_open' }),
  beat('old-open', 'r_0000000002', ago(30, 1), 1),
  beat('old-open', 'r_0000000002', ago(30, 2), 2),
  finish('old-open', 'r_0000000002', ago(29), 'done', {
    result: { commit: 'def5678', card: 'bl_open' },
  }),
  // (iii) old, failed, on a done card: stays
  start('old-failed', 'r_0000000003', ago(30), { card: 'bl_done' }),
  finish('old-failed', 'r_0000000003', ago(29), 'failed'),
  // (v) recent and running, five beats: keeps the last
  start('recent', 'r_0000000005', ago(1), { card: 'bl_open' }),
  ...[1, 2, 3, 4, 5].map((count) => beat('recent', 'r_0000000005', ago(1, count), count)),
  // old, finished a week ago on a done card: not old enough
  start('week', 'r_0000000006', ago(8), { card: 'bl_done' }),
  finish('week', 'r_0000000006', ago(7)),
  // old, never finished and replaced by a newer start of the same id: the first run ended at that start, 20 days ago
  start('again', 'r_0000000007', ago(40)),
  beat('again', 'r_0000000007', ago(40, 1), 1),
  start('again', 'r_0000000008', ago(20)),
  finish('again', 'r_0000000008', ago(5)),
  // (vi) a run that was moved to a card and acked-like events naming it after a newer start of the same id
  start('moved', 'r_0000000009', ago(60), { card: 'bl_open' }),
  finish('moved', 'r_0000000009', ago(59), 'done'),
  start('moved', 'r_0000000010', ago(50), { card: 'bl_open' }),
  row('card', 'moved', 'r_0000000009', ago(45), { card: 'bl_done' }),
  finish('moved', 'r_0000000010', ago(44)),
  // (iv) the SubagentStop hook ended it 39 days ago, the agent's own finish replaced that a day ago: the run ended a day ago
  start('hooked', 'r_0000000011', ago(40), { card: 'bl_done' }),
  finish('hooked', 'r_0000000011', ago(39), 'done', { by: 'auto-finish' }),
  beat('hooked', 'r_0000000011', ago(38), 9),
  finish('hooked', 'r_0000000011', ago(1), 'done'),
  // the hook's end, never replaced, 39 days ago on a done card: over for good, goes
  start('hooked-only', 'r_0000000012', ago(40), { card: 'bl_done' }),
  finish('hooked-only', 'r_0000000012', ago(39), 'done', { by: 'auto-finish' }),
  // a failed run acked long ago on a done card goes; one never acked stays (iii)
  start('acked', 'r_0000000013', ago(40), { card: 'bl_done' }),
  finish('acked', 'r_0000000013', ago(39), 'failed', { by: 'auto-finish' }),
  row('ack', 'acked', 'r_0000000013', ago(38)),
  // acked, then the agent resumed (a state after the hook's end clears the ack) and is still running: stays
  start('resumed', 'r_0000000014', ago(40), { card: 'bl_done' }),
  finish('resumed', 'r_0000000014', ago(39), 'failed', { by: 'auto-finish' }),
  row('ack', 'resumed', 'r_0000000014', ago(38)),
  row('state', 'resumed', 'r_0000000014', ago(37), { state: 'running' }),
];

test('(i) an old finished run on a done card goes with every event it has', () => {
  assert.ok(!names(compact(world)).includes('old-done'));
});

test('(ii) an old run on an open card, and (iii) an old failed run, stay as they were', () => {
  const kept = compact(world);
  const only = (name: string) => events(kept).filter((event) => event.name === name);
  assert.deepEqual(
    only('old-open').map((event) => event.op),
    ['start', 'beat', 'finish'],
    'the first beat goes, the last stays',
  );
  assert.equal(only('old-open')[1].n, 2);
  assert.deepEqual(
    only('old-failed').map((event) => event.op),
    ['start', 'finish'],
  );
});

test('(v) a recent run keeps its last beat, the one with the largest time', () => {
  const beats = events(compact(world)).filter(
    (event) => event.name === 'recent' && event.op === 'beat',
  );
  assert.deepEqual(
    beats.map((event) => event.n),
    [5],
  );
});

test('a run that ended inside the cutoff stays, and one the next start replaced goes by when it was replaced', () => {
  const kept = events(compact(world));
  assert.ok(kept.some((event) => event.name === 'week'));
  assert.deepEqual(
    kept.filter((event) => event.name === 'again').map((event) => [event.op, event.run]),
    [
      ['start', 'r_0000000008'],
      ['finish', 'r_0000000008'],
    ],
    'the run replaced 20 days ago (no card) went with its beat; the newer one ended 5 days ago',
  );
});

test('(vi) a card event naming an earlier run, after a newer start of the id, goes or stays with that run', () => {
  const kept = events(compact(world)).filter((event) => event.name === 'moved');
  // run 9 moved to bl_done (closed) and ended 59 days ago: it goes with its card event; run 10 is on an open card and stays
  assert.deepEqual(
    kept.map((event) => [event.op, event.run]),
    [
      ['start', 'r_0000000010'],
      ['finish', 'r_0000000010'],
    ],
  );
});

test('(iv) a run the hook ended and the agent finished later ended at the later finish: it stays whole', () => {
  const kept = events(compact(world)).filter((event) => event.name === 'hooked');
  assert.deepEqual(
    kept.map((event) => event.op),
    ['start', 'finish', 'finish'],
    'the beat after the hook is no sign of life the fold applied, so it goes',
  );
});

test('a hook-ended run never replaced goes; a failed run goes once acked, and stays when it ran again', () => {
  const kept = names(compact(world));
  assert.ok(!kept.includes('hooked-only'));
  assert.ok(!kept.includes('acked'));
  assert.ok(kept.includes('resumed'));
});

test('the fold of what stays is the fold of the whole, less the runs that went', () => {
  const before = foldAgentEvents(events(textOf(world)));
  const after = foldAgentEvents(events(compact(world)));
  const stays = (run: { run?: string | null }) => !!run.run;
  const runsOf = (agents: typeof before) =>
    agents.flatMap((agent) => [...(agent.earlier ?? []), { ...agent, earlier: undefined }]);
  const kept = new Map(
    runsOf(after)
      .filter(stays)
      .map((run) => [run.run, run]),
  );
  for (const run of runsOf(before)) {
    const now = kept.get(run.run);
    if (now) {
      assert.deepEqual(now, run, `${run.name} reads the same`);
    }
  }
  assert.ok(kept.has('r_0000000002') && kept.has('r_0000000003') && kept.has('r_0000000005'));
  assert.ok(!kept.has('r_0000000001'));
});

test('a line that is not an event stays, and nothing is kept for a log with nothing old', () => {
  const lines = ['not json', JSON.stringify(start('x', 'r_0000000001', ago(1)))];
  assert.deepEqual(compactAgentLines(lines, CUTOFF, cardState), lines);
});

test("the lines are the file's own, in its order, and a second pass changes nothing", () => {
  const once = compact(world);
  assert.deepEqual(
    once,
    textOf(world).filter((line) => once.includes(line)),
  );
  assert.deepEqual(compactAgentLines(once, CUTOFF, cardState), once);
});

test('a run on an implicit or unknown card stays: its runs are the only record of the card', () => {
  const rows = [
    start('implicit', 'r_0000000021', ago(30), { card: 'ic_x1' }),
    finish('implicit', 'r_0000000021', ago(29), 'done', { result: { commit: 'abc1234' } }),
    start('unknown', 'r_0000000022', ago(30), { card: 'bl_gone' }),
    finish('unknown', 'r_0000000022', ago(29)),
  ];
  assert.deepEqual(compact(rows), textOf(rows));
});

test('a run whose finish names an open card stays, and one that names a closed card goes', () => {
  const rows = [
    start('loose', 'r_0000000023', ago(30)),
    finish('loose', 'r_0000000023', ago(29), 'done', {
      result: { commit: 'abc1234', card: 'bl_open' },
    }),
    start('implicit', 'r_0000000024', ago(30), { card: 'ic_x2' }),
    finish('implicit', 'r_0000000024', ago(29), 'done', {
      result: { commit: 'def5678', card: 'bl_open' },
    }),
    start('shut', 'r_0000000025', ago(30)),
    finish('shut', 'r_0000000025', ago(29), 'done', {
      result: { commit: 'fed8765', card: 'bl_done' },
    }),
  ];
  assert.deepEqual(compact(rows), textOf(rows.slice(0, 4)));
});

test('an implicit card that was adopted and has landed no longer keeps its runs', () => {
  const rows = [
    start('adopted', 'r_0000000026', ago(30), { card: 'ic_x3' }),
    finish('adopted', 'r_0000000026', ago(29)),
  ];
  assert.deepEqual(
    compactAgentLines(textOf(rows), CUTOFF, (card) => (card === 'ic_x3' ? 'closed' : undefined)),
    [],
  );
});

test('the runs that go are returned for the archive, whole, and every line is kept, archived or a thinned beat', () => {
  const lines = textOf(world);
  const plan = planAgentLines(lines, CUTOFF, cardState);
  assert.deepEqual(names(plan.archived).sort(), [
    'acked',
    'again',
    'hooked-only',
    'moved',
    'old-done',
  ]);
  assert.ok(plan.archived.every((line) => lines.includes(line)));
  // what is neither kept nor archived is a beat
  const dropped = lines.filter(
    (line) => !plan.kept.includes(line) && !plan.archived.includes(line),
  );
  assert.ok(dropped.length > 0);
  assert.ok(dropped.every((line) => JSON.parse(line).op === 'beat'));
  // an archived run, with every line it had, folds as it did in the whole log
  const whole = foldAgentEvents(events(lines)).flatMap((agent) => [
    ...(agent.earlier ?? []),
    agent,
  ]);
  const archived = foldAgentEvents(events(plan.archived));
  const done = archived.find((agent) => agent.name === 'old-done');
  assert.deepEqual(
    done,
    whole.find((agent) => agent.run === 'r_0000000001' && agent.name === 'old-done'),
  );
});

test('a deploy finds the same commit for a card that stays, and the archive has the one that went', () => {
  const lines = textOf(world);
  const plan = planAgentLines(lines, CUTOFF, cardState);
  const before = recordedTips(events(lines));
  const after = recordedTips(events(plan.kept));
  assert.equal(after.get('bl_open'), 'def5678');
  assert.equal(after.get('bl_open'), before.get('bl_open'));
  assert.equal(before.get('bl_done'), 'abc1234');
  assert.equal(after.get('bl_done'), undefined);
  assert.equal(recordedTips(events(plan.archived)).get('bl_done'), 'abc1234');
});

test('a second pass archives nothing and changes nothing', () => {
  const first = planAgentLines(textOf(world), CUTOFF, cardState);
  const second = planAgentLines(first.kept, CUTOFF, cardState);
  assert.deepEqual(second.kept, first.kept);
  assert.deepEqual(second.archived, []);
});

test('with a fold cutoff, a run that finished after it keeps every beat, and one that finished before it keeps the last', () => {
  const rows = [
    start('fresh', 'r_0000000021', ago(3), { card: 'bl_open' }),
    beat('fresh', 'r_0000000021', ago(3, 1), 1),
    beat('fresh', 'r_0000000021', ago(3, 2), 2),
    finish('fresh', 'r_0000000021', ago(2)),
    start('older', 'r_0000000022', ago(20), { card: 'bl_open' }),
    beat('older', 'r_0000000022', ago(20, 1), 1),
    beat('older', 'r_0000000022', ago(20, 2), 2),
    finish('older', 'r_0000000022', ago(19)),
    start('going', 'r_0000000023', ago(1), { card: 'bl_open' }),
    beat('going', 'r_0000000023', ago(1, 1), 1),
    beat('going', 'r_0000000023', ago(1, 2), 2),
  ];
  const { kept } = planAgentLines(textOf(rows), CUTOFF, cardState, NOW - 14 * DAY);
  const beats = (name: string) =>
    events(kept).filter((event) => event.name === name && event.op === 'beat').length;
  assert.equal(beats('fresh'), 2);
  assert.equal(beats('older'), 1);
  assert.equal(beats('going'), 1, 'a run still going is thinned whatever its age');
  assert.deepEqual(
    events(kept)
      .filter((event) => event.name === 'fresh')
      .map((event) => event.op),
    ['start', 'beat', 'beat', 'finish'],
  );
});
