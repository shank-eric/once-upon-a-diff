import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { noteRead, readReads } from '../src/reads.ts';

test('reading a story that has no reads makes no folder, and noting a read makes it', () => {
  const home = tmp('home');
  const key = 'pr-octo-org-web-app-42';
  assert.deepEqual(readReads(home, key), {});
  assert.equal(existsSync(path.join(home, 'state')), false, 'a read left a folder behind');
  noteRead(home, key, 'c1');
  assert.deepEqual(Object.keys(readReads(home, key)), ['c1']);
});
