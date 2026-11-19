import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takesEvent } from '../src/records/agents/events.ts';

const run = (state: string, name: string | null = 'r1') =>
  ({ state, run: name }) as Parameters<typeof takesEvent>[0];

test('takesEvent: an open run takes an event with no run, or its own', () => {
  assert.equal(takesEvent(run('running'), undefined, false), true);
  assert.equal(takesEvent(run('fixing'), 'r1', false), true);
  assert.equal(takesEvent(run('running', null), 'r2', false), true);
});

test('takesEvent: an event naming another run is not for this one', () => {
  assert.equal(takesEvent(run('running'), 'r2', false), false);
});

test('takesEvent: a finished run takes none unless its auto-finish is being replaced', () => {
  assert.equal(takesEvent(run('done'), 'r1', false), false);
  assert.equal(takesEvent(run('failed'), undefined, false), false);
  assert.equal(takesEvent(run('done'), 'r1', true), true);
  assert.equal(takesEvent(run('done'), 'r2', true), false);
});
