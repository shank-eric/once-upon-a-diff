/*
 * What doctor --fix keeps of backlog.jsonl (src/queues/backlog/backlog-compact.ts): the stored cards nobody can still be on go with
 * their events, a card someone added stays whole, and the listed cards fold as they did, in the same order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldBacklog } from '../src/queues/backlog/backlog.ts';
import { compactBacklogLines, planBacklogLines } from '../src/queues/backlog/backlog-compact.ts';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const CUTOFF = NOW - 14 * DAY;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

type Row = Record<string, unknown>;
const add = (id: string, days: number, more: Row = {}): Row => ({
  op: 'add',
  id,
  title: `card ${id}`,
  note: null,
  repo: null,
  branch: null,
  by: 'test',
  at: ago(days),
  ...more,
});
const event = (kind: string, id: string, days: number, more: Row = {}): Row => ({
  op: kind,
  id,
  by: 'test',
  at: ago(days),
  ...more,
});
const lines = (rows: Row[]) => rows.map((row) => JSON.stringify(row));
const compact = (rows: Row[], named: string[] = []) =>
  compactBacklogLines(lines(rows), {
    cutoffMs: CUTOFF,
    named: (id) => named.includes(id),
  });
const ids = (kept: string[]) => [...new Set(kept.map((line) => JSON.parse(line).id as string))];

test('200 old agent and session cards with no run go; the 5 backlog cards and the recent ones stay', () => {
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(add(`bl_back${i}`, 40));
  }
  for (let i = 0; i < 200; i++) {
    const id = `ic_old${String(i).padStart(3, '0')}`;
    rows.push(
      add(id, 30, { source: i % 2 ? 'agent' : 'session' }),
      event('link', id, 29, { branch: `b-${i}` }),
    );
  }
  rows.push(
    add('ic_recent00', 2, { source: 'agent' }),
    add('bl_recent01', 1, { source: 'session' }),
  );
  const kept = ids(compact(rows));
  assert.deepEqual(kept, [
    ...Array.from({ length: 5 }, (_, i) => `bl_back${i}`),
    'ic_recent00',
    'bl_recent01',
  ]);
});

test('a card named by a surviving run, or by a move as `before`, stays', () => {
  const rows = [
    add('ic_named00', 30, { source: 'agent' }),
    add('ic_target', 30, { source: 'agent' }),
    add('bl_mover00', 30),
    event('move', 'bl_mover00', 29, { before: 'ic_target' }),
    add('ic_gone00', 30, { source: 'agent' }),
  ];
  assert.deepEqual(ids(compact(rows, ['ic_named00'])), ['ic_named00', 'ic_target', 'bl_mover00']);
});

test('an old closed PR or story card goes; an open one with no events for 30 days stays', () => {
  const rows = [
    add('bl_prclosed', 50, { source: 'pr', pr: 5, repo: 'o/r', branch: 'b-5' }),
    event('drop', 'bl_prclosed', 40),
    add('bl_storyland', 50, { source: 'story', story: 'abc' }),
    event('done', 'bl_storyland', 35),
    add('bl_proldopen', 50, { source: 'pr', pr: 6, repo: 'o/r', branch: 'b-6' }),
    add('bl_storyopen', 50, { source: 'story', story: 'def' }),
    add('bl_closedrecent', 50, { source: 'pr', pr: 7, repo: 'o/r', branch: 'b-7' }),
    event('drop', 'bl_closedrecent', 3),
  ];
  assert.deepEqual(ids(compact(rows)), ['bl_proldopen', 'bl_storyopen', 'bl_closedrecent']);
});

test('a promoted card (link source backlog) stays whole, even closed and old', () => {
  const rows = [
    add('ic_promoted', 60, { source: 'agent' }),
    event('link', 'ic_promoted', 59, { source: 'backlog' }),
    event('drop', 'ic_promoted', 40),
  ];
  assert.equal(compact(rows).length, 3);
});

test('a refused-start leftover (agent card, no run) goes after N days and stays inside N days', () => {
  const rows = [
    add('ic_leftold', 15, { source: 'agent' }),
    add('ic_leftnew', 13, { source: 'agent' }),
  ];
  assert.deepEqual(ids(compact(rows)), ['ic_leftnew']);
});

test('the latest event time counts, not the last line: a backfilled add is older than the lines around it', () => {
  const rows = [
    add('ic_late00', 30, { source: 'agent' }),
    event('claim', 'ic_late00', 1, { agent: 'a-b' }),
    event('link', 'ic_late00', 20, { branch: 'x' }),
  ];
  assert.deepEqual(ids(compact(rows)), ['ic_late00']);
});

test('a line that is not an event, and one for an id no add made, stays', () => {
  const kept = compactBacklogLines(
    [
      'not json',
      JSON.stringify(event('drop', 'bl_orphan', 40)),
      ...lines([add('ic_xxxxxx', 30, { source: 'agent' })]),
    ],
    { cutoffMs: CUTOFF, named: () => false },
  );
  assert.deepEqual(kept, ['not json', JSON.stringify(event('drop', 'bl_orphan', 40))]);
});

test('the listed cards come back in the same order and fold the same, whatever the moves', () => {
  let seed = 7;
  const random = (count: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % count;
  };
  const rows: Row[] = [];
  const all: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = i % 3 === 0 ? `ic_xxxxxx${i}` : `bl_l00${i}`;
    all.push(id);
    rows.push(add(id, 30 - i, i % 3 === 0 ? { source: 'agent' } : {}));
  }
  for (let i = 0; i < 60; i++) {
    const id = all[random(all.length)];
    // only the listed cards move, and each names a listed card or an edge
    if (id.startsWith('ic_')) {
      continue;
    }
    const listed = all.filter((one) => one.startsWith('bl_'));
    rows.push(
      random(4) === 0
        ? event('move', id, 25 - (i % 20), { edge: random(2) ? 'top' : 'bottom' })
        : event('move', id, 25 - (i % 20), { before: listed[random(listed.length)] }),
    );
  }
  const listedOf = (text: string[]) =>
    foldBacklog(text.join('\n')).filter((item) => (item.source ?? 'backlog') === 'backlog');
  const before = listedOf(lines(rows));
  const kept = compact(rows);
  assert.ok(kept.length < rows.length, 'something went');
  assert.deepEqual(listedOf(kept), before);
});

test('compacting twice drops nothing the second time', () => {
  const rows = [
    add('ic_aaaaaa', 30, { source: 'agent' }),
    add('bl_bbbbbb', 30),
    add('ic_cccccc', 1, { source: 'agent' }),
  ];
  const once = compact(rows);
  assert.deepEqual(compactBacklogLines(once, { cutoffMs: CUTOFF, named: () => false }), once);
});

test('an idle session card whose session is still live stays; one whose session is gone goes', () => {
  const rows = [
    add('ic_live0000', 30, { source: 'session', session: 'live-session-id' }),
    add('ic_gone0000', 30, { source: 'session', session: 'gone-session-id' }),
    add('ic_nosess00', 30, { source: 'session' }),
  ];
  const kept = ids(
    compactBacklogLines(lines(rows), {
      cutoffMs: CUTOFF,
      named: () => false,
      live: (session) => session === 'live-session-id',
    }),
  );
  assert.deepEqual(kept, ['ic_live0000']);
});

test('the cards that go are returned for the archive with every line they had, and what stays folds the same', () => {
  const rows = [
    add('bl_stays00', 40),
    event('start', 'bl_stays00', 39, { branch: 'b-1', repo: 'o/r' }),
    add('ic_gone000', 40, { source: 'agent' }),
    event('link', 'ic_gone000', 39, { branch: 'old' }),
    add('bl_prclosed', 50, { source: 'pr', pr: 5, repo: 'o/r', branch: 'b-5' }),
    event('drop', 'bl_prclosed', 40),
    add('ic_recent00', 1, { source: 'agent' }),
  ];
  const plan = planBacklogLines(lines(rows), { cutoffMs: CUTOFF, named: () => false });
  assert.deepEqual(ids(plan.archived), ['ic_gone000', 'bl_prclosed']);
  assert.equal(plan.archived.length, 4);
  assert.equal(plan.kept.length + plan.archived.length, rows.length);
  // what went folds, alone, as the card did in the whole log; what stays folds as it did
  const whole = foldBacklog(lines(rows).join('\n'));
  for (const card of foldBacklog(plan.archived.join('\n'))) {
    assert.deepEqual(
      card,
      whole.find((one) => one.id === card.id),
    );
  }
  for (const card of foldBacklog(plan.kept.join('\n'))) {
    assert.deepEqual(
      card,
      whole.find((one) => one.id === card.id),
    );
  }
  // a second pass has nothing to move
  const second = planBacklogLines(plan.kept, { cutoffMs: CUTOFF, named: () => false });
  assert.deepEqual(second.kept, plan.kept);
  assert.deepEqual(second.archived, []);
});
