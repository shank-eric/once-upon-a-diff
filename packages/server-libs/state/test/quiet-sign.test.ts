import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quietSign } from '../src/records/agents/auto-end.ts';

const run = {
  state: 'running',
  name: 'ou-a',
  kind: 'author',
  lastEvent: new Date(1_000_000),
} as never;

test('quietSign is the later of the transcript write and the last event, and no verdict without a usable write', () => {
  assert.equal(quietSign(run, 2_000_000), 2_000_000);
  assert.equal(quietSign(run, 500_000), 1_000_000);
  for (const bad of [undefined, 0, -5, NaN, Infinity]) {
    assert.equal(quietSign(run, bad), null);
  }
  assert.equal(quietSign({ ...(run as object), state: 'plan' } as never, 2_000_000), null);
  assert.equal(quietSign({ ...(run as object), standing: true } as never, 2_000_000), null);
});
