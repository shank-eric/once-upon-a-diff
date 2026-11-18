import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE_ROWS, cardPhase } from '../src/queues/backlog/phase.ts';
import type { LedgerAgent } from '../src/records/agents/ledger.ts';

// cardPhase says which row of the ADR-25 table decided the column (`once-upon card status` prints it)
const NOW = Date.parse('2026-11-16T15:00:00Z');
const minutes = (count: number) => new Date(NOW - count * 60000);
const run = (extra: Partial<LedgerAgent>): LedgerAgent => ({
  sid: 'abcdef01',
  name: 'self-aaaaaa',
  state: 'running',
  model: null,
  modelName: null,
  task: 't',
  started: minutes(60),
  ended: null,
  outcome: null,
  kind: 'author',
  ...extra,
});
const plain = { state: 'started' as const, repo: 'acme/widgets', branch: 'feat/x' };
const done = run({ state: 'done', ended: minutes(30) });
const passed = run({
  kind: 'critic',
  name: 'review',
  state: 'done',
  ended: minutes(20),
  findings: 0,
});

test('every branch of cardPhase names its row', () => {
  const cases: Array<[string, ReturnType<typeof cardPhase>]> = [
    ['1', cardPhase(plain, [run({})], NOW)],
    ['1', cardPhase(plain, [run({ state: 'waiting' })], NOW)],
    ['1', cardPhase(plain, [run({ state: 'plan' })], NOW)],
    ['2', cardPhase(plain, [done, run({ kind: 'critic', name: 'review' })], NOW)],
    ['3', cardPhase(plain, [run({ state: 'failed', ended: minutes(5) })], NOW)],
    [
      '3b',
      cardPhase(
        plain,
        [
          run({ state: 'done', ended: minutes(30) }),
          run({ kind: 'storyteller', name: 'story-x', lastEvent: minutes(1) }),
        ],
        NOW,
      ),
    ],
    [
      '4',
      cardPhase(
        plain,
        [
          run({ state: 'done', ended: minutes(30) }),
          run({ kind: 'critic', name: 'review', state: 'done', ended: minutes(20), findings: 2 }),
        ],
        NOW,
      ),
    ],
    ['5', cardPhase(plain, [done], NOW)],
    ['6', cardPhase(plain, [done, passed], NOW)],
    ['7', cardPhase({ ...plain, branch: null }, [run({ state: 'done', ended: minutes(30) })], NOW)],
  ];
  for (const [row, phase] of cases) {
    assert.equal(phase?.row, row);
    assert.ok(Object.hasOwn(PHASE_ROWS, row));
  }
  assert.equal(Object.keys(PHASE_ROWS).length, 8);
});

test('a storyteller silent for 61 minutes holds nothing, one silent for 59 minutes still holds Agent checks; other runs keep the 24 hour cutoff', () => {
  const done = run({ state: 'done', ended: minutes(300) });
  const storyteller = (silent: number) =>
    run({
      kind: 'storyteller',
      name: 'story-x',
      started: minutes(300),
      lastEvent: minutes(silent),
    });
  assert.equal(cardPhase(plain, [done, storyteller(59)], NOW)?.row, '3b');
  assert.equal(cardPhase(plain, [done, passed, storyteller(61)], NOW)?.row, '6');
  // a critic silent 61 minutes is not dead yet (the 24 hour cutoff is only for a storyteller to leave)
  const critic = run({
    kind: 'critic',
    name: 'review',
    started: minutes(300),
    lastEvent: minutes(61),
  });
  assert.equal(cardPhase(plain, [done, critic], NOW)?.row, '2');
});

test('the rows read the same in every repo: no repo name decides one', () => {
  const rows = (repo: string) =>
    [
      [done],
      [done, run({ kind: 'critic', name: 'review' })],
      [
        done,
        run({ kind: 'critic', name: 'review', state: 'done', ended: minutes(20), findings: 2 }),
      ],
      [done, passed],
    ].map((runs) => cardPhase({ ...plain, repo }, runs, NOW)?.row);
  for (const repo of ['larmor', 'once-upon-a-diff', 'everfi-frontend', 'acme/widgets']) {
    assert.deepEqual(rows(repo), ['5', '2', '4', '6']);
  }
});

test('row 5: a built card with no passing critic is Waiting, and a failed or stopped critic does not pass', () => {
  assert.deepEqual(
    [cardPhase(plain, [done], NOW)?.column, cardPhase(plain, [done, passed], NOW)?.column],
    ['waiting', 'ready'],
  );
  for (const state of ['failed', 'stopped'] as const) {
    const critic = run({ kind: 'critic', name: 'review', state, ended: minutes(20) });
    assert.equal(cardPhase(plain, [done, critic], NOW)?.row, '5');
  }
  // a critic still running is Agent checks, not Waiting
  const running = run({ kind: 'critic', name: 'review' });
  assert.equal(cardPhase(plain, [done, running], NOW)?.column, 'checks');
});

test('row 5 keeps its built guard: a card with no branch (nothing built) and a finished run is Done, in any repo', () => {
  for (const repo of ['larmor', 'acme/widgets']) {
    for (const state of ['started', 'open'] as const) {
      assert.equal(cardPhase({ state, repo, branch: null }, [done], NOW)?.row, '7');
    }
  }
});

test('row 5: a recorded skip lets the built card through to row 6', () => {
  const skipped = { ...plain, critic_skipped: true };
  assert.deepEqual(
    [cardPhase(skipped, [done], NOW)?.row, cardPhase(skipped, [done], NOW)?.column],
    ['6', 'ready'],
  );
  // the skip does not hide an open critic
  assert.equal(cardPhase(skipped, [done, run({ kind: 'critic', name: 'r' })], NOW)?.row, '2');
});

test('row 6: skipsReview makes the finished card Ready to ship, whatever the repo is called', () => {
  for (const repo of ['larmor', 'acme/widgets']) {
    const item = { ...plain, repo };
    assert.equal(cardPhase(item, [done, passed], NOW)?.column, 'ready');
    assert.equal(cardPhase(item, [done, passed], NOW, undefined, false)?.column, 'ready');
    assert.equal(cardPhase(item, [done, passed], NOW, undefined, true)?.column, 'ship');
  }
});

test('a landed card is not built: no critic holds it, and it reads Done (row 7)', () => {
  const landed = { ...plain, landed_at: new Date(NOW - 10 * 60000).toISOString() };
  assert.deepEqual(
    [cardPhase(landed, [done], NOW)?.row, cardPhase(landed, [done], NOW)?.column],
    ['7', 'done'],
  );
  assert.equal(cardPhase({ ...landed, critic_skipped: true }, [done], NOW)?.row, '7');
});

test('a failed work run is Error, an acknowledged or stopped one is back in Backlog, tried', () => {
  const failed = run({ state: 'failed', ended: minutes(5) });
  assert.deepEqual(cardPhase(plain, [failed], NOW), {
    column: 'error',
    when: NOW - 5 * 60000,
    tried: false,
    row: '3',
  });
  for (const over of [
    { state: 'failed' as const, acked: minutes(1) },
    { state: 'stopped' as const },
  ]) {
    const phase = cardPhase(plain, [{ ...failed, ...over }], NOW);
    assert.deepEqual([phase?.column, phase?.tried, phase?.row], ['backlog', true, '3']);
  }
});

test('a work run parked on your story review is Ready, a question is Waiting', () => {
  assert.equal(cardPhase(plain, [run({ state: 'waiting', review: true })], NOW)?.column, 'ready');
  assert.equal(cardPhase(plain, [run({ state: 'waiting' })], NOW)?.column, 'waiting');
});
