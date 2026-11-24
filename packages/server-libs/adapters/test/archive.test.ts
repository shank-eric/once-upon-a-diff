/*
 * The archive of the compacted logs (src/stores/fs/archive.ts): rows go to the month's file, a row already there is not written
 * again, and a reader takes each line once, oldest month first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { appendArchive, archiveDir, monthOf, readArchive } from '../src/stores/fs/archive.ts';

test('rows go to their month, a second write of the same rows adds none, and the files are the owner’s alone', () => {
  const home = tmp('archive');
  const rows = [
    { month: '2026-10', line: '{"n":1}' },
    { month: '2026-11', line: '{"n":2}' },
    { month: '2026-10', line: '{"n":3}' },
  ];
  assert.equal(appendArchive(home, 'agents', rows), 3);
  assert.equal(
    appendArchive(home, 'agents', rows),
    0,
    'a crash before the swap writes them again: nothing is doubled',
  );
  assert.equal(appendArchive(home, 'agents', [...rows, { month: '2026-11', line: '{"n":4}' }]), 1);
  assert.deepEqual(readdirSync(archiveDir(home)).sort(), [
    'agents-2026-10.jsonl',
    'agents-2026-11.jsonl',
  ]);
  assert.equal(
    readFileSync(path.join(archiveDir(home), 'agents-2026-10.jsonl'), 'utf8'),
    '{"n":1}\n{"n":3}\n',
  );
  assert.equal(statSync(path.join(archiveDir(home), 'agents-2026-10.jsonl')).mode & 0o777, 0o600);
});

test('a reader takes the store’s lines once, oldest month first, and none of another store', () => {
  const home = tmp('archive');
  assert.equal(readArchive(home, 'agents'), '', 'no archive yet');
  appendArchive(home, 'agents', [
    { month: '2026-11', line: '{"n":2}' },
    { month: '2026-10', line: '{"n":1}' },
  ]);
  appendArchive(home, 'backlog', [{ month: '2026-10', line: '{"b":1}' }]);
  assert.equal(readArchive(home, 'agents'), '{"n":1}\n{"n":2}\n');
  assert.equal(readArchive(home, 'backlog'), '{"b":1}\n');
});

test('the month of a time, and none for a time that is not one', () => {
  assert.equal(monthOf('2026-11-24T10:00:00Z'), '2026-11');
  assert.equal(monthOf('soon'), null);
  assert.equal(monthOf(undefined), null);
});
