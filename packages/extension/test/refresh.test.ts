import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  createPings,
  DROP_MS,
  FIRST_PING_MS,
  SECOND_PING_MS,
  type Pending,
  type PendingStore,
} from '../src/content/refresh.ts';
import type { Intent } from '@once-upon-a-diff/host-github/actions';

const START = 1_000_000;
const REVIEW: Intent = { reason: 'review', repo: 'Acme/Widgets', number: 42 };

/** A timer the test runs by hand: what a hidden tab still has (the router's tick does not run there). */
function manualTimer() {
  const runs: (() => void)[] = [];
  return {
    runs,
    start: (run: () => void) => {
      runs.push(run);
      return runs.length;
    },
    stop: (id: unknown) => void (runs[(id as number) - 1] = () => undefined),
    active: () => runs.length,
  };
}

function pings(store?: PendingStore, fail = false, clock = { at: START }) {
  const sent: Intent[] = [];
  const kept: { list: Pending[] } = { list: [] };
  const timer = manualTimer();
  const made = createPings({
    call: async (body) => {
      sent.push(body);
      if (fail) {
        throw new Error('extension reloaded');
      }
    },
    store: store ?? {
      read: async () => kept.list,
      write: (list) => void (kept.list = list),
    },
    timer,
    now: () => clock.at,
    pathname: () => '/Acme/Widgets/pull/42/files',
  });
  return { sent, made, kept, timer, clock };
}

test('an intent is pinged 1.5 s and 8 s after, each once, and then forgotten', () => {
  const { sent, made } = pings();
  made.add(REVIEW, START);
  made.tick(START + 700, '/Acme/Widgets/pull/42/files');
  assert.deepEqual(sent, []);
  made.tick(START + FIRST_PING_MS, '/Acme/Widgets/pull/42/files');
  made.tick(START + FIRST_PING_MS + 700, '/Acme/Widgets/pull/42/files');
  assert.deepEqual(sent, [REVIEW], 'the body is the intent, with no timing fields');
  made.tick(START + SECOND_PING_MS - 1, '/Acme/Widgets/pull/42/files');
  assert.equal(sent.length, 1);
  made.tick(START + SECOND_PING_MS, '/Acme/Widgets/pull/42/files');
  assert.equal(sent.length, 2);
  made.tick(START + SECOND_PING_MS + 700, '/Acme/Widgets/pull/42/files');
  assert.equal(sent.length, 2);
  assert.deepEqual(made.pending(), []);
});

test('an intent past a minute is dropped unsent (a tab that was hidden or asleep)', () => {
  const { sent, made } = pings();
  made.add(REVIEW, START);
  made.tick(START + DROP_MS + 1, '/');
  assert.deepEqual(sent, []);
  assert.deepEqual(made.pending(), []);
});

test('the same action twice is one, and no more than 5 are kept', () => {
  const { made } = pings();
  made.add(REVIEW, START);
  made.add(REVIEW, START + 100);
  assert.equal(made.pending().length, 1);
  for (let step = 1; step <= 7; step++) {
    made.add({ reason: 'merge', repo: 'Acme/Widgets', number: step }, START + step);
  }
  assert.equal(made.pending().length, 5);
  assert.equal(made.pending().at(-1)?.number, 7);
});

test('a PR just opened gets its number from the page it lands on; a fork’s waits for it', async () => {
  const { sent, made, kept } = pings();
  made.add({ reason: 'open', repo: 'Acme/Widgets', branch: 'fix-it' }, START);
  made.add({ reason: 'open', repo: 'Acme/Widgets' }, START + 1); // a fork's: no branch to name
  // the compare page after the click: the branch alone is enough, a fork's has nothing to send yet
  made.tick(START + FIRST_PING_MS + 10, '/Acme/Widgets/compare/main...fix-it');
  assert.deepEqual(sent, [{ reason: 'open', repo: 'Acme/Widgets', branch: 'fix-it' }]);
  // GitHub's redirect lands on the new PR: both learn its number (a full reload kept them in storage)
  const reloaded = createPings({
    call: async (body) => void sent.push(body),
    store: { read: async () => kept.list, write: (list) => void (kept.list = list) },
    timer: manualTimer(),
    now: () => START + SECOND_PING_MS + 10,
  });
  await new Promise((resolve) => setImmediate(resolve));
  reloaded.tick(START + SECOND_PING_MS + 10, '/Acme/Widgets/pull/77');
  assert.deepEqual(sent.slice(1), [
    { reason: 'open', repo: 'Acme/Widgets', branch: 'fix-it', number: 77 },
    { reason: 'open', repo: 'Acme/Widgets', number: 77 },
  ]);
  // another repo's PR page is not this PR's landing page
  const other = pings();
  other.made.add({ reason: 'open', repo: 'Acme/Widgets' }, START);
  other.made.tick(START + FIRST_PING_MS, '/Someone/Else/pull/5');
  assert.deepEqual(other.sent, []);
});

test('a failing call, a store that throws, and a bridge that is gone never throw', () => {
  const failing = pings(undefined, true);
  failing.made.add(REVIEW, START);
  failing.made.tick(START + FIRST_PING_MS, '/');
  assert.equal(failing.sent.length, 1);
  const broken = pings({
    read: async () => {
      throw new Error('storage blocked');
    },
    write: () => {
      throw new Error('storage blocked');
    },
  });
  broken.made.add(REVIEW, START);
  broken.made.tick(START + FIRST_PING_MS, '/');
  assert.equal(broken.sent.length, 1, 'it goes on from memory');
});

test('the pings go out on their own timer, with no router tick (a hidden tab), and the timer stops when none wait', () => {
  const clock = { at: START };
  const { sent, made, timer } = pings(undefined, false, clock);
  assert.equal(timer.active(), 0, 'no timer while nothing waits');
  made.add(REVIEW, START);
  assert.equal(timer.active(), 1);
  clock.at = START + FIRST_PING_MS;
  timer.runs[0]();
  clock.at = START + SECOND_PING_MS;
  timer.runs[0]();
  assert.deepEqual(sent, [REVIEW, REVIEW]);
  assert.deepEqual(made.pending(), []);
  // a later intent starts a timer again
  made.add({ ...REVIEW, number: 43 }, clock.at);
  assert.equal(timer.active(), 2);
});

test('pending pings are kept in the extension’s storage, never the page’s (a page script can write that)', async () => {
  const code = readFileSync(
    path.join(import.meta.dirname, '../src/content/refresh.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/sessionStorage|localStorage|tabSession/.test(code));
  assert.match(code, /chrome\.storage\.local/);
  // what the extension kept before a reload is read back, only while fresh
  const kept: Pending[] = [
    { ...REVIEW, at: START, pings: 0 },
    { ...REVIEW, number: 9, at: START - DROP_MS - 1, pings: 0 },
  ];
  const reloaded = createPings({
    call: async () => undefined,
    store: { read: async () => kept, write: () => undefined },
    timer: manualTimer(),
    now: () => START,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    reloaded.pending().map((one) => one.number),
    [42],
  );
});
