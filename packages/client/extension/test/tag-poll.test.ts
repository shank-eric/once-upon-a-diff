import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@once-upon-a-diff/test-kit/dom';
import { createTagPoll, pollTargets } from '../src/content/tag-poll.ts';
import type { PrRef, StoryStatus } from '../src/content/tag-model.ts';

const { window, document } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
let visible = 'visible';
Object.defineProperty(document, 'visibilityState', { get: () => visible });
mock.timers.enable({ apis: ['setTimeout'] });
// the test kit's tick waits on a real setTimeout, which is faked here
const tick = () => new Promise((resolve) => setImmediate(resolve));

const PULL: PrRef = { repo: 'acme/widgets', number: 7 };

/** The poll over a tag state the test moves by hand; `due` records each time the page is told to look. */
function setup() {
  const state = { failed: false, inFlight: false, alive: true };
  const due: PrRef[][] = [];
  const poll = createTagPoll({
    failed: () => state.failed,
    waiting: () => (state.failed || state.inFlight ? [PULL] : []),
    alive: () => state.alive,
    onDue: (prs) => void due.push(prs),
  });
  return { state, due, poll };
}

test('while a story is in flight the page is told to look every 10 s, and not before', async () => {
  const { state, due, poll } = setup();
  state.inFlight = true;
  poll.start();
  await tick();
  assert.equal(due.length, 1, 'the poll’s first look at start');
  poll.reschedule();
  mock.timers.tick(9999);
  await tick();
  assert.equal(due.length, 1);
  mock.timers.tick(1);
  await tick();
  assert.equal(due.length, 2);
  assert.deepEqual(due[1], [PULL]);
  mock.timers.tick(10000);
  await tick();
  assert.equal(due.length, 3);
  poll.stop();
});

test('while the bridge is down it is every 30 s, and it comes back to 10 s when the bridge answers', async () => {
  const { state, due, poll } = setup();
  state.failed = true;
  state.inFlight = true;
  poll.start();
  await tick();
  assert.equal(due.length, 1);
  mock.timers.tick(29999);
  await tick();
  assert.equal(due.length, 1, 'not at 10 s');
  mock.timers.tick(1);
  await tick();
  assert.equal(due.length, 2, 'at 30 s');
  state.failed = false;
  poll.reschedule();
  mock.timers.tick(10000);
  await tick();
  assert.equal(due.length, 3, 'in flight again: 10 s');
  poll.stop();
});

test('idle with nothing in flight and the bridge up: no timer, until a look or a click says otherwise', async () => {
  const { state, due, poll } = setup();
  poll.start();
  await tick();
  mock.timers.tick(600000);
  await tick();
  assert.equal(due.length, 0);
  state.inFlight = true; // a click queued a story
  poll.reschedule();
  mock.timers.tick(10000);
  await tick();
  assert.equal(due.length, 1);
  state.inFlight = false; // it came back ready
  mock.timers.tick(10000);
  await tick();
  assert.equal(due.length, 1, 'the wait already running finds nothing to look at');
  mock.timers.tick(600000);
  await tick();
  assert.equal(due.length, 1, 'then idle');
  poll.stop();
});

test('it waits while the tab is hidden, looks when the window gets focus, and a reloaded extension is left alone', async () => {
  const { state, due, poll } = setup();
  state.inFlight = true;
  poll.start();
  await tick();
  assert.equal(due.length, 1);
  visible = 'hidden';
  mock.timers.tick(60000);
  await tick();
  assert.equal(due.length, 1, 'hidden: no look');
  visible = 'visible';
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(due.length, 2, 'focus looks at once');
  state.alive = false;
  mock.timers.tick(10000);
  await tick();
  assert.equal(due.length, 2, 'extension reloaded: nothing');
  poll.stop();
});

test('stop ends it: no more looks on the clock or on focus', async () => {
  const { state, due, poll } = setup();
  state.inFlight = true;
  poll.start();
  await tick();
  poll.stop();
  mock.timers.tick(60000);
  window.dispatchEvent(new window.Event('focus'));
  await tick();
  assert.equal(due.length, 1);
});

test('going from PR A, in flight, to PR B: only the PR on the page is watched, so B is not looked at every 10 s', async () => {
  const pullA: PrRef = { repo: 'acme/widgets', number: 1 };
  const pullB: PrRef = { repo: 'acme/widgets', number: 2 };
  const results = new Map<string, StoryStatus>([
    ['acme/widgets#1', { ...pullA, state: 'building' }],
    ['acme/widgets#2', { ...pullB, state: 'ready' }],
  ]);
  let onPage: PrRef[] = [pullA];
  const looked: PrRef[][] = [];
  const poll = createTagPoll({
    failed: () => false,
    waiting: () => pollTargets(results, false, onPage),
    alive: () => true,
    onDue: (prs) => void looked.push(prs),
  });
  poll.start();
  await tick();
  assert.deepEqual(looked, [[pullA]], 'on A it looks at A while it builds');
  onPage = [pullB]; // an in-page navigation: A is still in flight in the map, but the page is on B
  poll.reschedule();
  mock.timers.tick(600000);
  await tick();
  assert.equal(looked.length, 1, 'B is ready: nothing is due, and A is left alone');
  results.set('acme/widgets#2', { ...pullB, state: 'queued' });
  poll.reschedule();
  mock.timers.tick(10000);
  await tick();
  assert.deepEqual(looked.at(-1), [pullB], 'B in flight: B is looked at');
  poll.stop();
});

test('pollTargets: the PRs in flight, all of the page’s PRs while the bridge is down, and none off the page', () => {
  const one: PrRef = { repo: 'acme/widgets', number: 1 };
  const two: PrRef = { repo: 'acme/widgets', number: 2 };
  const results = new Map<string, StoryStatus>([
    ['acme/widgets#1', { ...one, state: 'building' }],
    ['acme/widgets#2', { ...two, state: 'ready' }],
  ]);
  const numbers = (prs: PrRef[]) => prs.map((pr) => pr.number);
  assert.deepEqual(numbers(pollTargets(results, false, null)), [1], 'a list: the ones in flight');
  assert.deepEqual(numbers(pollTargets(results, true, null)), [1, 2], 'bridge down: all of them');
  assert.deepEqual(pollTargets(results, false, [two]), [], 'a page on two: one is not watched');
  assert.deepEqual(
    pollTargets(new Map(), true, [two]),
    [two],
    'bridge down on a first look that failed',
  );
  assert.deepEqual(pollTargets(results, true, []), [], 'no PR on the page');
});

test('the poll hands each look the load’s signal, so the page can pass it to its call', async () => {
  const signals: AbortSignal[] = [];
  const poll = createTagPoll({
    failed: () => false,
    waiting: () => [PULL],
    alive: () => true,
    onDue: (_prs, signal) => void signals.push(signal),
  });
  poll.start();
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  poll.stop();
});
