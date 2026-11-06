import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { requestStop, stopRequested } from '../src/features/listeners/auto-stop.ts';
import { listeners, touchHandling } from '@once-upon-a-diff/state/records/listeners/listeners';

test('stopRequested: no usable stops file is null even for a wait that started at 0', () => {
  const home = tmp('stops');
  assert.equal(stopRequested(home, 'o/r', 0), null);
  writeFileSync(path.join(home, 'listener-stops.json'), '{not json');
  assert.equal(stopRequested(home, 'o/r', 0), null);
  writeFileSync(path.join(home, 'listener-stops.json'), 'null');
  assert.equal(stopRequested(home, 'o/r', 0), null);
});

test('requestStop and stopRequested: a stop after the wait started counts, one before it does not; a broken file starts over', () => {
  const home = tmp('stops');
  writeFileSync(path.join(home, 'listener-stops.json'), '{not json');
  requestStop(home, 'O/R', 1000);
  assert.equal(stopRequested(home, 'o/r', 900), 'stopped from the board');
  assert.equal(stopRequested(home, 'o/r', 1001), null);
  assert.equal(stopRequested(home, 'x/y', 0), 'stopped from the board'); // a file with no entry for the repo, as before
});

test('listeners: a missing, broken or null beat file is skipped; touchHandling leaves those alone', () => {
  const home = tmp('beats');
  const dir = path.join(home, 'listeners');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'broken.json'), '{not json');
  writeFileSync(path.join(dir, 'null.json'), 'null');
  writeFileSync(
    path.join(dir, 'ok.json'),
    JSON.stringify({
      consumer: 'ok',
      pid: process.pid,
      state: 'handling',
      at: new Date().toISOString(),
    }),
  );
  assert.deepEqual(
    listeners(home).map((one) => one.consumer),
    ['ok'],
  );
  touchHandling(home, 'broken');
  touchHandling(home, 'null');
  touchHandling(home, 'nobody');
  assert.equal(listeners(home).length, 1);
});
