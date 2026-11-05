import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@once-upon-a-diff/test-kit/dom';
import { createPoll, type PollView } from '../src/poll.ts';

const { window, document } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
let visible = 'visible';
Object.defineProperty(document, 'visibilityState', { get: () => visible });
mock.timers.enable({ apis: ['setTimeout'] });
// the test kit's tick waits on a real setTimeout, which is faked here
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A poll over a `load` that answers what the test queues: a value, or an Error to fail with. */
function setup(...answers: Array<string | Error>) {
  const views: PollView<string>[] = [];
  const calls: number[] = [];
  const queue = [...answers];
  const poll = createPoll<string>({
    everyMs: 3000,
    load: async () => {
      calls.push(calls.length);
      const next = queue.shift() ?? 'more';
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    onChange: (view) => views.push(view),
  });
  return { poll, views, calls };
}

test('start loads at once and hands over the data', async () => {
  const { poll, views } = setup('one');
  poll.start();
  await tick();
  assert.deepEqual(views, [{ data: 'one', error: null, failed: 0 }]);
  poll.stop();
});

test('it loads again each interval, but not while the tab is hidden', async () => {
  const { poll, calls } = setup();
  poll.start();
  await tick();
  assert.equal(calls.length, 1);
  mock.timers.tick(3000);
  await tick();
  assert.equal(calls.length, 2);
  visible = 'hidden';
  mock.timers.tick(3000);
  await tick();
  assert.equal(calls.length, 2, 'hidden: no load');
  visible = 'visible';
  mock.timers.tick(3000);
  await tick();
  assert.equal(calls.length, 3);
  poll.stop();
});

test('it loads when the window gets the focus back', async () => {
  const { poll, calls } = setup();
  poll.start();
  await tick();
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(calls.length, 2);
  poll.stop();
});

test('a failed load keeps the last data and counts the failures in a row; a good one resets them', async () => {
  const { poll, views } = setup('one', new Error('down'), new Error('still down'), 'two');
  poll.start();
  await tick();
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(3000);
    await tick();
  }
  assert.deepEqual(
    views.map((view) => [view.data, view.error?.message ?? null, view.failed]),
    [
      ['one', null, 0],
      ['one', 'down', 1],
      ['one', 'still down', 2],
      ['two', null, 0],
    ],
  );
  poll.stop();
});

test('refresh loads now; after stop nothing loads and a late answer is dropped', async () => {
  const { poll, views, calls } = setup('one', 'two');
  poll.start();
  await tick();
  await poll.refresh();
  assert.equal(views.at(-1)?.data, 'two');
  const before = calls.length;
  const late = poll.refresh();
  poll.stop();
  await late;
  mock.timers.tick(3000);
  await tick();
  assert.equal(calls.length, before + 1, 'only the refresh already sent');
  assert.equal(views.at(-1)?.data, 'two', 'its answer was dropped');
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(calls.length, before + 1, 'the focus no longer loads');
});

test('a load from before a stop is dropped even when the poll was started again', async () => {
  const views: PollView<string>[] = [];
  const waiting: Array<(value: string) => void> = [];
  const poll = createPoll<string>({
    everyMs: 3000,
    load: () => new Promise<string>((resolve) => waiting.push(resolve)),
    onChange: (view) => views.push(view),
  });
  poll.start();
  poll.stop();
  poll.start();
  assert.equal(waiting.length, 2, 'the first run’s load and the second run’s');
  waiting[0]('stale');
  await tick();
  assert.deepEqual(views, [], 'the first run’s answer is dropped');
  waiting[1]('fresh');
  await tick();
  assert.deepEqual(views, [{ data: 'fresh', error: null, failed: 0 }]);
  poll.stop();
});

test('it waits everyMs after each load, not on a fixed clock', async () => {
  const { poll, calls } = setup();
  poll.start();
  await tick();
  mock.timers.tick(2999);
  await tick();
  assert.equal(calls.length, 1, 'not yet');
  mock.timers.tick(1);
  await tick();
  assert.equal(calls.length, 2);
  poll.stop();
});

test('everyMs as a function is read before each wait, and null leaves the poll idle until reschedule', async () => {
  let wait: number | null = 10000;
  const calls: number[] = [];
  const poll = createPoll<number>({
    everyMs: () => wait,
    load: async () => calls.push(calls.length),
    onChange: () => {},
  });
  poll.start();
  await tick();
  mock.timers.tick(9999);
  await tick();
  assert.equal(calls.length, 1);
  mock.timers.tick(1);
  await tick();
  assert.equal(calls.length, 2, 'after the 10 s it named');
  wait = 30000;
  mock.timers.tick(10000);
  await tick();
  assert.equal(calls.length, 3);
  mock.timers.tick(29999);
  await tick();
  assert.equal(calls.length, 3, 'now the wait is 30 s');
  mock.timers.tick(1);
  await tick();
  assert.equal(calls.length, 4);
  wait = null;
  mock.timers.tick(30000);
  await tick();
  assert.equal(calls.length, 5, 'the wait already set still ran');
  mock.timers.tick(600000);
  await tick();
  assert.equal(calls.length, 5, 'null: idle');
  wait = 5000;
  poll.reschedule();
  mock.timers.tick(5000);
  await tick();
  assert.equal(calls.length, 6, 'reschedule starts the wait again');
  poll.stop();
  mock.timers.tick(600000);
  await tick();
  assert.equal(calls.length, 6, 'stopped');
});

test('whenHidden fires only while the tab is hidden, with no first load and no focus load, and stops', async () => {
  const calls: number[] = [];
  const poll = createPoll<number>({
    everyMs: 60000,
    whenHidden: true,
    load: async () => calls.push(calls.length),
    onChange: () => {},
  });
  visible = 'visible';
  poll.start();
  await tick();
  assert.equal(calls.length, 0, 'no first load');
  mock.timers.tick(60000);
  await tick();
  assert.equal(calls.length, 0, 'visible: nothing');
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(calls.length, 0, 'no focus load');
  visible = 'hidden';
  mock.timers.tick(60000);
  await tick();
  assert.equal(calls.length, 1, 'hidden: it fires');
  mock.timers.tick(60000);
  await tick();
  assert.equal(calls.length, 2);
  poll.stop();
  mock.timers.tick(60000);
  await tick();
  assert.equal(calls.length, 2, 'stopped');
  visible = 'visible';
});

test('a throwing onChange does not end the poll', async () => {
  let loads = 0;
  const poll = createPoll<number>({
    everyMs: 3000,
    load: async () => ++loads,
    onChange: ({ data }) => {
      if (data === 2) {
        throw new Error('boom');
      }
    },
  });
  poll.start();
  await tick();
  let thrown: unknown = null;
  await poll.refresh().catch((err) => void (thrown = err));
  assert.equal((thrown as Error)?.message, 'boom', 'the throw is not swallowed');
  mock.timers.tick(3000);
  await tick();
  assert.equal(loads, 3, 'the next load still comes on the clock');
  poll.stop();
});
