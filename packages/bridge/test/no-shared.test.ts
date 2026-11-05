/*
 * packages/shared is gone: what was in it lives in the domain package, the panel, the web package or github-page, and
 * nothing names the old package or the URLs its files were served at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('there is no packages/shared', () => {
  assert.equal(existsSync(`${ROOT}packages/shared`), false);
});

test('no tracked file names the shared package or the URLs it was served at', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(
      (file) =>
        /\.(ts|mjs|json|md|sh|yml)$/.test(file) &&
        !file.startsWith('docs/') &&
        file !== 'packages/bridge/test/no-shared.test.ts' &&
        file !== 'packages/bridge/test/side-effects-lint.test.ts' &&
        existsSync(`${ROOT}${file}`),
    );
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(`${ROOT}${file}`, 'utf8');
    for (const old of [
      '@once-upon-a-diff/shared',
      'packages/shared',
      '/assets/util/',
      '/assets/host/',
    ]) {
      if (text.includes(old)) {
        found.push(`${file}: ${old}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
