import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../bridge/cli/args.mjs';
import { usageText, commandNames } from '../bridge/cli/index.mjs';

test('the CLI parses flags, repeats, -o and bare words', () => {
  const { command, opts } = parseArgs([
    'backstory',
    '--repo',
    'x',
    '--brief',
    '--exclude-agent',
    'a1',
    '--exclude-agent',
    'a2',
    '-o',
    'out.json',
    'word',
    '--root',
    'r1',
  ]);
  assert.equal(command, 'backstory');
  assert.equal(opts.repo, 'x');
  assert.equal(opts.brief, true);
  assert.deepEqual(opts.excludeAgents, ['a1', 'a2']);
  assert.equal(opts.o, 'out.json');
  assert.deepEqual(opts._, ['word']);
  assert.deepEqual(opts.root, ['r1']);
});

test('the help lists every command in the table, once', () => {
  const { table, help } = commandNames();
  assert.deepEqual([...table].sort(), [...help].sort());
  const text = usageText();
  for (const name of table) {
    assert.match(text, new RegExp(`diff-story ${name}\\b`), name);
  }
});
