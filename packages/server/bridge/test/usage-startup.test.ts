import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import type { CoverageFile } from '@once-upon-a-diff/usage/merge';

const ROOT = path.resolve(import.meta.dirname, '..');

test('a flush before the bridge listens keeps its startup coverage for the first flush after the port binds', () => {
  const home = tmp('home');
  const script = `
    import { begin } from ${JSON.stringify(path.join(ROOT, 'instrumentation/usage-probe.ts'))};
    begin(['serve']);
    const { installUsage, bridgeListening } = await import(${JSON.stringify(path.join(ROOT, '../../server-libs/usage/src/capture.ts'))});
    const { etDay } = await import(${JSON.stringify(path.join(ROOT, '../../server-libs/usage/src/days.ts'))});
    etDay(new Date()); // startup code that runs before the port binds
    const capture = installUsage(['serve']);
    capture.flush(); // the first flush, before listening
    bridgeListening();
    capture.flush();
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ONCE_UPON_HOME: home, ONCE_UPON_USAGE: 'force' },
    stdio: 'pipe',
  });
  const file = JSON.parse(
    readFileSync(path.join(home, 'usage', 'coverage-bridge.json'), 'utf8'),
  ) as CoverageFile;
  assert.ok(file.starts >= 1);
  assert.ok(
    Object.keys(file.files).some((name) => name.endsWith('usage/src/days.ts')),
    Object.keys(file.files).join(', '),
  );
});
