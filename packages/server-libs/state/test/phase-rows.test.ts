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
const holding = { ...plain, repo: 'shank-eric/once-upon-a-diff' };

test('every branch of cardPhase names its row', () => {
  const cases: Array<[string, ReturnType<typeof cardPhase>]> = [
    ['1', cardPhase(plain, [run({})], NOW)],
    ['1', cardPhase(plain, [run({ state: 'waiting' })], NOW)],
    ['1', cardPhase(plain, [run({ state: 'plan' })], NOW)],
    [
      '2',
      cardPhase(
        holding,
        [run({ state: 'done', ended: minutes(30) }), run({ kind: 'critic', name: 'review' })],
        NOW,
      ),
    ],
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
        holding,
        [
          run({ state: 'done', ended: minutes(30) }),
          run({ kind: 'critic', name: 'review', state: 'done', ended: minutes(20), findings: 2 }),
        ],
        NOW,
      ),
    ],
    ['5', cardPhase(holding, [run({ state: 'done', ended: minutes(30) })], NOW)],
    ['6', cardPhase(plain, [run({ state: 'done', ended: minutes(30) })], NOW)],
    ['7', cardPhase({ ...plain, branch: null }, [run({ state: 'done', ended: minutes(30) })], NOW)],
  ];
  for (const [row, phase] of cases) {
    assert.equal(phase?.row, row);
    assert.ok(Object.hasOwn(PHASE_ROWS, row));
  }
  assert.equal(Object.keys(PHASE_ROWS).length, 8);
});
