import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { agentsOnCard, runsOf } from '../src/queues/backlog/phase.ts';
import type { LedgerAgent } from '../src/records/agents/ledger.ts';

const run = (
  name: string,
  card: string | null,
  startedMinute: number,
  earlier: LedgerAgent[] = [],
) =>
  ({
    name,
    card,
    kind: 'author',
    state: 'done',
    started: new Date(Date.UTC(2026, 10, 23, 12, startedMinute)),
    earlier,
  }) as unknown as LedgerAgent;

test('runsOf: the runs naming a card, earlier ones too, oldest first, from one index per agents list', () => {
  const first = run('build-x', 'bl_x', 1);
  const agents = [
    run('build-x', 'bl_x', 30, [first]),
    run('critic-x', 'bl_x', 10),
    run('other', 'bl_y', 5),
    run('loose', null, 6),
  ];
  assert.deepEqual(
    runsOf({ id: 'bl_x' }, agents).map((one) => `${one.name}@${one.started?.getUTCMinutes()}`),
    ['build-x@1', 'critic-x@10', 'build-x@30'],
  );
  assert.deepEqual(runsOf({ id: 'bl_nobody' }, agents), []);
  assert.deepEqual(
    agentsOnCard({ id: 'bl_y' }, agents).map((one) => one.name),
    ['other'],
  );
  // a list that grows is read again, and a caller changing what it was handed does not change the next answer
  runsOf({ id: 'bl_x' }, agents).pop();
  agents.push(run('late', 'bl_x', 50));
  assert.deepEqual(
    runsOf({ id: 'bl_x' }, agents).map((one) => one.name),
    ['build-x', 'critic-x', 'build-x', 'late'],
  );
});
