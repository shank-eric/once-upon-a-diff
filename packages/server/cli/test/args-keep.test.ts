import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';

test('--keep is a boolean flag: a word after it stays a word, with --json after it too', () => {
  assert.deepEqual(parseArgs(['wait', '--repo', 'a/b', '--keep', 'word']).opts, {
    repo: 'a/b',
    keep: true,
    _: ['word'],
  });
  assert.deepEqual(parseArgs(['wait', '--keep', '--json']).opts, { keep: true, json: true });
});
