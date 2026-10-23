import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { tmp, localRepo, writeJson } from './helpers.ts';
import { loadConfig, readSettings, UNPACKED_EXTENSION_ID } from '../src/config/settings.ts';
import { storyDirFor } from '../src/stories/placement.ts';

const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);

test("the bridge's folder and a checkout's .once-upon are the user's alone, even when they were there already", () => {
  const home = tmp('home');
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o755);
  loadConfig(home);
  assert.equal(modeOf(home), '700');
  assert.equal(modeOf(path.join(home, 'config.json')), '600');

  const { repo } = localRepo();
  mkdirSync(path.join(repo, '.once-upon'), { mode: 0o755 });
  chmodSync(path.join(repo, '.once-upon'), 0o755);
  const dir = storyDirFor(home, 'local-x', { checkout: repo });
  assert.equal(dir, path.join(repo, '.once-upon', 'local-x'));
  assert.equal(modeOf(path.join(repo, '.once-upon')), '700');
});

test('the fixed unpacked extension ID is always allowed, and extension_ids adds others', () => {
  const home = tmp('home');
  assert.deepEqual(readSettings(home).extensionIds, [UNPACKED_EXTENSION_ID]);
  writeJson(path.join(home, 'config.json'), {
    extension_ids: ['abcdefghijklmnopabcdefghijklmnop', 'not-an-id', 7],
  });
  assert.deepEqual(readSettings(home).extensionIds, [
    UNPACKED_EXTENSION_ID,
    'abcdefghijklmnopabcdefghijklmnop',
  ]);
});
