/** The `ack` event (`agent ack`): a failed run, acknowledged. It marks the run and changes nothing else, and is no sign of life. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAgentEvents } from '../src/records/agents/events.ts';
import { readAgentEvent, type AgentEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { strictAgentEvent } from '@once-upon-a-diff/contracts/files/strict';

const whenOf = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 12, minutes)).toISOString();
const base = { id: 'aaaaaaaa:ou-a', sid8: 'aaaaaaaa', name: 'ou-a', by: 'cli' };
const start = (run: string, minutes: number): AgentEvent => ({
  ...base,
  op: 'start',
  run,
  kind: 'author',
  task: 't',
  at: whenOf(minutes),
});
const finish = (run: string, minutes: number, state: 'done' | 'failed' = 'failed'): AgentEvent => ({
  ...base,
  op: 'finish',
  run,
  state,
  outcome: 'broke',
  at: whenOf(minutes),
});
const ack = (run: string | undefined, minutes: number): AgentEvent => ({
  ...base,
  op: 'ack',
  ...(run ? { run } : {}),
  at: whenOf(minutes),
});

test('an ack marks the finished run acked and leaves its state, end, outcome and last sign of life alone', () => {
  const [agent] = foldAgentEvents([start('r_1', 0), finish('r_1', 5), ack('r_1', 30)]);
  assert.equal(agent.acked?.toISOString(), whenOf(30));
  assert.equal(agent.state, 'failed');
  assert.equal(agent.outcome, 'broke');
  assert.equal(agent.ended?.toISOString(), whenOf(5));
  assert.equal(agent.lastEvent?.toISOString(), whenOf(5));
});

test('an ack names an earlier run by its run id, and marks only that one', () => {
  const [agent] = foldAgentEvents([
    start('r_1', 0),
    finish('r_1', 5),
    start('r_2', 10),
    ack('r_1', 30),
  ]);
  assert.equal(agent.acked, undefined, 'the latest run stays unacked');
  assert.equal(agent.earlier?.[0].acked?.toISOString(), whenOf(30));
});

test('a later run of the name is not acked, and an ack of a run still open changes nothing', () => {
  const [again] = foldAgentEvents([
    start('r_1', 0),
    finish('r_1', 5),
    ack('r_1', 6),
    start('r_2', 10),
  ]);
  assert.equal(again.acked, undefined);
  const open = [start('r_1', 0)];
  const before = JSON.stringify(foldAgentEvents(open));
  assert.equal(JSON.stringify(foldAgentEvents([...open, ack('r_1', 30)])), before);
  assert.equal(JSON.stringify(foldAgentEvents([...open, ack(undefined, 30)])), before);
});

test('the ack row reads, and the writer check wants its run id', () => {
  const line = { v: 1, ...ack('r_aaaaaaaaaa', 30) };
  assert.equal(readAgentEvent(line)?.op, 'ack');
  assert.deepEqual(strictAgentEvent(line), []);
  assert.ok(strictAgentEvent({ v: 1, ...ack(undefined, 30) }).length > 0);
});
