import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bridge/cli/args.mjs';
import { usageText, commandNames } from '../bridge/cli/index.mjs';

const BIN = fileURLToPath(new URL('../bridge/bin/once-upon.mjs', import.meta.url));

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
    assert.match(text, new RegExp(`once-upon ${name}\\b`), name);
  }
});

test('the CLI moves an old ~/.diff-story to ~/.once-upon once, and leaves both alone after', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'once-upon-legacy-'));
  mkdirSync(path.join(fakeHome, '.diff-story'));
  writeFileSync(path.join(fakeHome, '.diff-story', 'inbox.jsonl'), '{}\n');
  const env = { ...process.env, HOME: fakeHome };
  delete env.ONCE_UPON_HOME;
  const run = () => spawnSync(process.execPath, [BIN, 'list'], { env, encoding: 'utf8' });
  const first = run();
  assert.match(first.stderr, /moved .*\.diff-story to .*\.once-upon/);
  assert.equal(existsSync(path.join(fakeHome, '.diff-story')), false);
  assert.equal(existsSync(path.join(fakeHome, '.once-upon', 'inbox.jsonl')), true);
  mkdirSync(path.join(fakeHome, '.diff-story'));
  assert.doesNotMatch(run().stderr, /moved/, 'a ~/.once-upon that exists is never replaced');
  assert.equal(existsSync(path.join(fakeHome, '.diff-story')), true);
});

test('the CLI moves an old ~/.pr-story to ~/.once-upon once, with config paths into it', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'once-upon-legacy-'));
  const old = path.join(fakeHome, '.pr-story');
  mkdirSync(old);
  mkdirSync(path.join(fakeHome, '.diff-story'));
  writeFileSync(
    path.join(old, 'config.json'),
    JSON.stringify({ token: 't', port: 4823, house_rules: '~/.pr-story/house-rules.md' }),
  );
  const env = { ...process.env, HOME: fakeHome };
  delete env.ONCE_UPON_HOME;
  const run = () => spawnSync(process.execPath, [BIN, 'list'], { env, encoding: 'utf8' });
  const first = run();
  assert.match(first.stderr, /moved .*\.pr-story to .*\.once-upon/);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(path.join(fakeHome, '.diff-story')), true, 'the newer old name wins');
  const cfg = JSON.parse(readFileSync(path.join(fakeHome, '.once-upon', 'config.json'), 'utf8'));
  assert.equal(cfg.house_rules, '~/.once-upon/house-rules.md');
  assert.equal(cfg.token, 't');
  assert.doesNotMatch(run().stderr, /moved/);
});
