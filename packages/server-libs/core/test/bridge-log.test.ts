import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { makeBridgeLog } from '../src/orchestration/bridge/bridge-log.ts';

test('the log keeps to its cap: the old lines go to .1, the file stays one inode and 0600', () => {
  const file = path.join(tmp('home'), 'bridge.log');
  const log = makeBridgeLog(file, 200);
  const line = 'x'.repeat(59) + '\n'; // 60 bytes
  log(line);
  log(line);
  log(line);
  const inode = statSync(file).ino;
  log(line); // would be 240: rotates first
  assert.equal(readFileSync(`${file}.1`, 'utf8'), line.repeat(3));
  assert.equal(readFileSync(file, 'utf8'), line);
  assert.equal(statSync(file).ino, inode, 'truncated in place, not renamed');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
});

test('a log already over the cap rotates on the first write, and .1 is replaced each time', () => {
  const file = path.join(tmp('home'), 'bridge.log');
  writeFileSync(file, 'old\n'.repeat(100));
  const log = makeBridgeLog(file, 200);
  log('first\n');
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'old\n'.repeat(100));
  assert.equal(readFileSync(file, 'utf8'), 'first\n');
  log('y'.repeat(250) + '\n');
  log('second\n');
  assert.ok(readFileSync(`${file}.1`, 'utf8').startsWith('y'));
  assert.equal(readFileSync(file, 'utf8'), 'second\n');
});
