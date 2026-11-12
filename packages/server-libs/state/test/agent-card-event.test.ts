/** The `card` event (`backlog drop --into`): it moves one run, open or over, to another card, and is no sign of life. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAgentEvents } from '../src/records/agents/events.ts';
import type { AgentEvent } from '@once-upon-a-diff/contracts/files/schemas';

const whenOf = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 12, minutes)).toISOString();
const base = { id: 'aaaaaaaa:ou-a', sid8: 'aaaaaaaa', name: 'ou-a', by: 'cli' };
const start = (run: string, minutes: number, card: string): AgentEvent => ({
  ...base,
  op: 'start',
  run,
  kind: 'author',
  task: 't',
  card,
  at: whenOf(minutes),
});
const finish = (run: string, minutes: number, result?: AgentEvent['result']): AgentEvent => ({
  ...base,
  op: 'finish',
  run,
  state: 'done',
  ...(result ? { result } : {}),
  at: whenOf(minutes),
});
const move = (run: string | undefined, minutes: number, card: string): AgentEvent => ({
  ...base,
  op: 'card',
  ...(run ? { run } : {}),
  card,
  at: whenOf(minutes),
});

test('a card event moves the open run and leaves its state, end and last sign of life alone', () => {
  const [agent] = foldAgentEvents([start('r_1', 0, 'bl_one'), move('r_1', 30, 'bl_two')]);
  assert.equal(agent.card, 'bl_two');
  assert.equal(agent.state, 'running');
  assert.equal(agent.ended, null);
  assert.equal(agent.lastEvent?.toISOString(), whenOf(0));
});

test('a card event moves a finished run, and the result card with it when it named the old card', () => {
  const [agent] = foldAgentEvents([
    start('r_1', 0, 'bl_one'),
    finish('r_1', 5, { commit: 'abc1234', card: 'bl_one' }),
    move('r_1', 30, 'bl_two'),
  ]);
  assert.equal(agent.card, 'bl_two');
  assert.equal(agent.state, 'done');
  assert.deepEqual(agent.result, { commit: 'abc1234', card: 'bl_two' });
  assert.equal(agent.ended?.toISOString(), whenOf(5));
});

test('a result that named another card keeps it', () => {
  const [agent] = foldAgentEvents([
    start('r_1', 0, 'bl_one'),
    finish('r_1', 5, { card: 'bl_other' }),
    move('r_1', 30, 'bl_two'),
  ]);
  assert.equal(agent.card, 'bl_two');
  assert.equal(agent.result?.card, 'bl_other');
});

test('a card event names an earlier run by its run id, and moves only that one', () => {
  const [agent] = foldAgentEvents([
    start('r_1', 0, 'bl_one'),
    finish('r_1', 5, { commit: 'abc1234', card: 'bl_one' }),
    start('r_2', 10, 'bl_one'),
    move('r_1', 30, 'bl_two'),
  ]);
  assert.equal(agent.card, 'bl_one', 'the latest run stays');
  assert.equal(agent.state, 'running');
  assert.equal(agent.earlier?.length, 1);
  assert.equal(agent.earlier?.[0].card, 'bl_two');
  assert.equal(agent.earlier?.[0].result?.card, 'bl_two');
});

test('a card event for a run that does not exist changes nothing', () => {
  const events = [start('r_1', 0, 'bl_one'), finish('r_1', 5, { card: 'bl_one' })];
  const before = JSON.stringify(foldAgentEvents(events));
  assert.equal(JSON.stringify(foldAgentEvents([...events, move('r_9', 30, 'bl_two')])), before);
  assert.equal(JSON.stringify(foldAgentEvents([move('r_1', 30, 'bl_two'), ...events])), before);
});
