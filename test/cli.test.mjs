import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../bridge/cli/args.mjs';
import { usageText, commandNames } from '../bridge/cli/index.mjs';

test('the CLI parses flags and bare words', () => {
  const { command, opts } = parseArgs(['local', 'word', '--repo', 'x', '--brief']);
  assert.equal(command, 'local');
  assert.equal(opts.repo, 'x');
  assert.equal(opts.brief, true);
  assert.deepEqual(opts._, ['word']);
});

test('the help lists every command in the table, once', () => {
  const { table, help } = commandNames();
  assert.deepEqual([...table].sort(), [...help].sort());
  const text = usageText();
  for (const name of table) {
    assert.match(text, new RegExp(`diff-story ${name}\\b`), name);
  }
});
