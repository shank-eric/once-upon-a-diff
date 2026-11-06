import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';
import { usageText, commandNames } from '../src/index.ts';

test('the CLI parses flags and bare words', () => {
  const { command, opts } = parseArgs(['local', 'word', '--repo', 'x', '--brief']);
  assert.equal(command, 'local');
  assert.equal(opts.repo, 'x');
  assert.equal(opts.brief, true);
  assert.deepEqual(opts._, ['word']);
});

test('a boolean flag takes no value: --dry-run leaves the next bare word a word', () => {
  const { opts } = parseArgs(['backlog', 'land', '--dry-run', 'abc1234', '--from', 'main']);
  assert.equal(opts['dry-run'], true);
  assert.deepEqual(opts._, ['land', 'abc1234']);
  assert.equal(opts.from, 'main');
});

test('after a bare -- everything is a word, even one that starts with --', () => {
  const { opts } = parseArgs([
    'agent',
    'beat',
    'x',
    '--no-mirror',
    '--',
    '--force removed',
    '--keep',
  ]);
  assert.equal(opts['no-mirror'], true);
  assert.equal(opts.force, undefined);
  assert.deepEqual(opts._, ['beat', 'x', '--force removed', '--keep']);
});

test('the help lists every command in the table, once', () => {
  const { table, help } = commandNames();
  assert.deepEqual([...table].sort(), [...help].sort());
  const text = usageText();
  for (const name of table) {
    assert.match(text, new RegExp(`once-upon ${name}\\b`), name);
  }
});
