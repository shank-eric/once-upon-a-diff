import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import {
  readPendingFiles,
  removePending,
  sweepClaimed,
  writePending,
} from '../src/claude-sessions/pending-listen.ts';

test('a request is written whole and owner-only, read back, and removed', () => {
  const home = tmp('pending-listen');
  writePending(home, 'repo-acme-widgets', '{"v":1}');
  writePending(home, 'repo-acme-widgets', '{"v":2}'); // a second click refreshes the one file
  const dir = path.join(home, 'pending-listen');
  assert.deepEqual(readdirSync(dir), ['repo-acme-widgets.json']);
  assert.equal(statSync(path.join(dir, 'repo-acme-widgets.json')).mode & 0o777, 0o600);
  assert.deepEqual(readPendingFiles(home), [{ key: 'repo-acme-widgets', text: '{"v":2}' }]);
  removePending(home, 'repo-acme-widgets');
  removePending(home, 'repo-acme-widgets');
  assert.deepEqual(readPendingFiles(home), []);
});

test('only repo-… and story-… keys name a file; strays in the folder are not requests', () => {
  const home = tmp('pending-listen-keys');
  for (const key of ['../x', 'a/b', 'repo-', 'other-x', 'repo-a b']) {
    assert.throws(() => writePending(home, key, '{}'), /not a pending-listen key/, key);
  }
  assert.deepEqual(readPendingFiles(path.join(home, 'nope')), []);
  const dir = path.join(home, 'pending-listen');
  mkdirSync(path.join(dir, 'claimed'), { recursive: true });
  writeFileSync(path.join(dir, 'notes.txt'), 'x');
  writeFileSync(path.join(dir, 'weird.json'), 'x');
  writeFileSync(path.join(dir, 'story-x.json'), '{}');
  assert.deepEqual(
    readPendingFiles(home).map((one) => one.key),
    ['story-x'],
  );
  removePending(home, 'a b'); // a name that is no key removes nothing
});

test('sweepClaimed removes only claimed files older than the limit', () => {
  const home = tmp('pending-listen-claimed');
  const dir = path.join(home, 'pending-listen', 'claimed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'old.json'), '{}');
  writeFileSync(path.join(dir, 'new.json'), '{}');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path.join(dir, 'old.json'), old, old);
  sweepClaimed(home, 15 * 60 * 1000);
  assert.equal(existsSync(path.join(dir, 'old.json')), false);
  assert.equal(existsSync(path.join(dir, 'new.json')), true);
  sweepClaimed(path.join(home, 'nope'), 1);
});
