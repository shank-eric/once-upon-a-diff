import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { document, window } from './dom-env.ts';

const { startLocalPolls } = await import('../public/local/polls.ts');

let visible = 'visible';
Object.defineProperty(document, 'visibilityState', { get: () => visible });
mock.timers.enable({ apis: ['setTimeout'] });
// the DOM env's tick waits on a real setTimeout, which is faked here
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const state = { closed: true, reloads: 0, seen: 0 };
  const stop = startLocalPolls({
    closed: () => state.closed,
    reload: () => void state.reloads++,
    seen: async () => void state.seen++,
  });
  return { state, stop };
}

test('with the panel closed it checks for a new version every 5 s while the tab shows, and not while it is hidden', async () => {
  visible = 'visible';
  const { state, stop } = setup();
  await tick();
  const start = state.reloads;
  mock.timers.tick(4999);
  await tick();
  assert.equal(state.reloads, start, 'not before 5 s');
  mock.timers.tick(1);
  await tick();
  assert.equal(state.reloads, start + 1);
  mock.timers.tick(5000);
  await tick();
  assert.equal(state.reloads, start + 2);
  visible = 'hidden';
  mock.timers.tick(30000);
  await tick();
  assert.equal(state.reloads, start + 2, 'hidden: no check');
  visible = 'visible';
  stop();
});

test('with the panel open it does not check (the panel’s own tick does), and focus checks only when closed', async () => {
  visible = 'visible';
  const { state, stop } = setup();
  state.closed = false;
  await tick();
  const start = state.reloads;
  mock.timers.tick(30000);
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(state.reloads, start, 'open: nothing');
  state.closed = true;
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(state.reloads, start + 1, 'closed: focus checks at once');
  stop();
});

test('the keepalive says "still open" about once a minute while the tab is hidden, never while it shows', async () => {
  visible = 'visible';
  const { state, stop } = setup();
  await tick();
  mock.timers.tick(180000);
  await tick();
  assert.equal(state.seen, 0, 'a showing tab says nothing');
  visible = 'hidden';
  mock.timers.tick(59999);
  await tick();
  assert.equal(state.seen, 0);
  mock.timers.tick(1);
  await tick();
  assert.equal(state.seen, 1);
  mock.timers.tick(60000);
  await tick();
  assert.equal(state.seen, 2);
  visible = 'visible';
  stop();
});

test('stop ends both', async () => {
  visible = 'visible';
  const { state, stop } = setup();
  await tick();
  stop();
  const [reloads, seen] = [state.reloads, state.seen];
  visible = 'hidden';
  mock.timers.tick(300000);
  visible = 'visible';
  mock.timers.tick(300000);
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.deepEqual([state.reloads, state.seen], [reloads, seen]);
});
