import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bridge/cli/args.mjs';
import { usageText, commandNames } from '../bridge/cli/index.mjs';

const BIN = fileURLToPath(new URL('../bridge/bin/pr-story.mjs', import.meta.url));

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
    assert.match(text, new RegExp(`pr-story ${name}\\b`), name);
  }
});

test('the CLI moves an old ~/.diff-story to ~/.pr-story once, and leaves both alone after', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'pr-story-legacy-'));
  mkdirSync(path.join(fakeHome, '.diff-story'));
  writeFileSync(path.join(fakeHome, '.diff-story', 'inbox.jsonl'), '{}\n');
  const env = { ...process.env, HOME: fakeHome };
  delete env.PR_STORY_HOME;
  const run = () => spawnSync(process.execPath, [BIN, 'list'], { env, encoding: 'utf8' });
  const first = run();
  assert.match(first.stderr, /moved .*\.diff-story to .*\.pr-story/);
  assert.equal(existsSync(path.join(fakeHome, '.diff-story')), false);
  assert.equal(existsSync(path.join(fakeHome, '.pr-story', 'inbox.jsonl')), true);
  mkdirSync(path.join(fakeHome, '.diff-story'));
  assert.doesNotMatch(run().stderr, /moved/, 'a ~/.pr-story that exists is never replaced');
  assert.equal(existsSync(path.join(fakeHome, '.diff-story')), true);
});
