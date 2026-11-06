import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { appendUsageLine, readUsageText, writeUsageJson } from '../src/adapters/usage-file.ts';

const text = (file: string) => readFileSync(file, 'utf8');
const mode = (file: string) => statSync(file).mode & 0o777;

test('usage/: JSON files and the capped log are 0600 in a 0700 folder', () => {
  const home = tmp('fmt-usage');
  writeUsageJson(home, 'settings.json', { epoch: 1 });
  assert.equal(text(path.join(home, 'usage', 'settings.json')), '{\n  "epoch": 1\n}');
  assert.equal(mode(path.join(home, 'usage', 'settings.json')), 0o600);
  assert.equal(mode(path.join(home, 'usage')), 0o700);
  appendUsageLine(home, 'cli.log', 'a', 100);
  appendUsageLine(home, 'cli.log', 'b', 100);
  assert.equal(readUsageText(home, 'cli.log'), 'a\nb\n');
  assert.equal(mode(path.join(home, 'usage', 'cli.log')), 0o600);
  appendUsageLine(home, 'cli.log', 'c', 4);
  assert.equal(readUsageText(home, 'cli.log'), 'a\nb\n', 'at the cap: nothing more is written');
});
