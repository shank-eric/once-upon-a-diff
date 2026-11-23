import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { onBackgroundChange } from '../src/change-signal.ts';
import { forgetItermTabs, keptItermTabs } from '../src/iterm.ts';

const sessions = [
  { session: 'one', tty: '/dev/ttys001' },
  { session: 'two', tty: '/dev/ttys002' },
];
const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/** A fake it2 that logs each call and lists the tabs in its `tabs.json`. */
function fakeIt2(
  dir: string,
  tabs: string[],
): { it2: string; calls: () => number; tabs: (next: string[]) => void } {
  const it2 = path.join(dir, 'it2');
  const setTabs = (list: string[]) =>
    writeFileSync(
      path.join(dir, 'tabs.json'),
      JSON.stringify(list.map((tty, i) => ({ id: `w${i}`, tty }))),
    );
  setTabs(tabs);
  writeFileSync(it2, `#!/bin/sh\necho x >> '${dir}/calls.log'\ncat '${dir}/tabs.json'\n`);
  chmodSync(it2, 0o755);
  return {
    it2,
    tabs: setTabs,
    calls: () =>
      existsSync(path.join(dir, 'calls.log'))
        ? readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').length
        : 0,
  };
}

test('keptItermTabs: builds inside the window share one it2 call; a changed tab set shows on the build after it lands and tells the board', async () => {
  forgetItermTabs();
  const fake = fakeIt2(tmp('iterm-kept'), ['/dev/ttys001']);
  let told = 0;
  const stop = onBackgroundChange(() => (told += 1));
  try {
    assert.deepEqual([...(await keptItermTabs(fake.it2, sessions))], ['one']);
    assert.deepEqual([...(await keptItermTabs(fake.it2, sessions))], ['one']);
    assert.equal(fake.calls(), 1, 'the second build asked no one');
    assert.equal(told, 0, 'the first look is no news');
    fake.tabs(['/dev/ttys001', '/dev/ttys002']);
    await pause(2100);
    // older than the window: still the kept set at once, and one look in the background
    assert.deepEqual([...(await keptItermTabs(fake.it2, sessions))], ['one']);
    for (let waited = 0; told === 0 && waited < 5000; waited += 100) {
      await pause(100);
    }
    assert.equal(told, 1, 'the changed set told the board');
    assert.deepEqual([...(await keptItermTabs(fake.it2, sessions))].sort(), ['one', 'two']);
    assert.equal(fake.calls(), 2);
  } finally {
    stop();
    forgetItermTabs();
  }
});

test('keptItermTabs: a hung it2 holds the first build for a second at most, and the late answer tells the board', async () => {
  forgetItermTabs();
  const dir = tmp('iterm-hung');
  const it2 = path.join(dir, 'it2');
  writeFileSync(it2, `#!/bin/sh\nsleep 1.6\ncat '${dir}/tabs.json'\n`);
  chmodSync(it2, 0o755);
  writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify([{ id: 'w0', tty: '/dev/ttys001' }]));
  let told = 0;
  const stop = onBackgroundChange(() => (told += 1));
  try {
    const started = Date.now();
    assert.equal((await keptItermTabs(it2, sessions)).size, 0, 'no answer in time: no tabs');
    assert.ok(Date.now() - started < 1500, `held ${Date.now() - started} ms`);
    for (let waited = 0; told === 0 && waited < 5000; waited += 100) {
      await pause(100);
    }
    assert.equal(told, 1);
    assert.deepEqual([...(await keptItermTabs(it2, sessions))], ['one']);
  } finally {
    stop();
    forgetItermTabs();
  }
});
