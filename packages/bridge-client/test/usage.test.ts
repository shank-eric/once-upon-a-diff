import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsage } from '../src/usage.ts';

const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

test('counts are batched into one send, and nothing goes out while there is nothing to say', async () => {
  const sent: Record<string, number>[] = [];
  const usage = createUsage(async (counts) => {
    sent.push(counts);
    return { on: true };
  }, 20);
  await usage.flush();
  assert.equal(sent.length, 0);
  usage.count('board.tab.switch');
  usage.count('board.tab.switch');
  usage.count('board.lane.toggle');
  assert.equal(sent.length, 0, 'not at once');
  await wait(60);
  assert.deepEqual(sent, [{ 'board.tab.switch': 2, 'board.lane.toggle': 1 }]);
  await wait(60);
  assert.equal(sent.length, 1, 'and no more once it is empty');
});

test('flush sends now (the tab is being hidden)', async () => {
  const sent: Record<string, number>[] = [];
  const usage = createUsage(async (counts) => {
    sent.push(counts);
    return { on: true };
  }, 60_000);
  usage.count('panel.close');
  await usage.flush();
  assert.deepEqual(sent, [{ 'panel.close': 1 }]);
});

test('a batch that did not get through is kept for the next one', async () => {
  const sent: Record<string, number>[] = [];
  let reachable = false;
  const usage = createUsage(async (counts) => {
    sent.push(counts);
    return reachable ? { on: true } : null;
  }, 20);
  usage.count('panel.step.next');
  await usage.flush();
  usage.count('panel.step.next');
  reachable = true;
  await wait(60);
  assert.deepEqual(sent.at(-1), { 'panel.step.next': 2 });
});

test('when the bridge says the capture is off the counter stops for good', async () => {
  let calls = 0;
  const usage = createUsage(async () => {
    calls++;
    return { on: false };
  }, 20);
  usage.count('panel.step.next');
  await usage.flush();
  usage.count('panel.step.next');
  await wait(60);
  assert.equal(calls, 1);
});

test('a send that throws is treated as not delivered, and tried again later', async () => {
  let calls = 0;
  const usage = createUsage(async () => {
    calls++;
    if (calls === 1) {
      throw new Error('offline');
    }
    return { on: false }; // the second try gets through (and ends the retries)
  }, 20);
  usage.count('panel.step.next');
  await usage.flush();
  await wait(60);
  assert.equal(calls, 2);
});
