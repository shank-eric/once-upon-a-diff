import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmp, runCli } from './helpers.ts';
import { assertPrivate } from './usage-helpers.ts';
import { isLinkedWorktree } from '@once-upon-a-diff/usage/adapters/session';
import { commandLabel } from '@once-upon-a-diff/usage/cli-log';
import { COMMAND_AREAS } from '@once-upon-a-diff/usage/areas';
import { commandNames } from '@once-upon-a-diff/cli/index';
import type { CoverageFile } from '@once-upon-a-diff/usage/merge';

/** `force` captures even when these tests run in a linked worktree (an agent's checkout is skipped otherwise). */
const FORCE = { ONCE_UPON_USAGE: 'force' };
const usageFile = (home: string, name: string) => path.join(home, 'usage', name);
const readCoverage = (home: string) =>
  JSON.parse(readFileSync(usageFile(home, 'coverage-cli.json'), 'utf8')) as CoverageFile;

test('a CLI run is captured: coverage per file, a command line, and nothing else', async () => {
  const home = tmp('home');
  const run = await runCli(home, ['backlog', 'list'], FORCE);
  assert.equal(run.code, 0, run.stderr);
  const coverage = readCoverage(home);
  const index = coverage.files['packages/cli/src/index.ts'];
  assert.ok(index, 'the CLI entry is in the coverage');
  assert.equal(index[0].mode, 'function');
  assert.match(index[0].sha, /^[0-9a-f]{8}$/);
  // the report's own command never counts itself, and the capture's bootstrap is not measured
  assert.ok(!coverage.files['packages/bridge/instrumentation/usage-probe.ts']);
  assert.ok(!coverage.files['packages/usage/src/adapters/session.ts']);
  assert.ok(!coverage.files['packages/bridge/bin/once-upon.mjs']);
  assert.equal(
    readFileSync(usageFile(home, 'cli-runs.log'), 'utf8').trim().split(' ')[1],
    'backlog.list',
  );
  assertPrivate(home);
});

test('a second identical run teaches nothing new and rewrites nothing; a different command adds lines', async () => {
  const home = tmp('home');
  await runCli(home, ['backlog', 'list'], FORCE);
  const before = statSync(usageFile(home, 'coverage-cli.json')).mtimeMs;
  const first = readFileSync(usageFile(home, 'coverage-cli.json'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.equal(
    statSync(usageFile(home, 'coverage-cli.json')).mtimeMs,
    before,
    'no write when nothing is new',
  );
  assert.equal(readFileSync(usageFile(home, 'coverage-cli.json'), 'utf8'), first);
  assert.equal(readFileSync(usageFile(home, 'cli-runs.log'), 'utf8').trim().split('\n').length, 2);
  await runCli(home, ['agent', 'list'], FORCE);
  assert.notEqual(
    readFileSync(usageFile(home, 'coverage-cli.json'), 'utf8'),
    first,
    'a new command ran new functions',
  );
});

test('C7: only names from the closed lists reach the log, whatever was typed', async () => {
  const home = tmp('home');
  await runCli(home, ['zzz-my-secret-story', 'text-with-private-words'], FORCE);
  await runCli(home, ['backlog', 'a-free-text-title-that-is-private'], FORCE);
  await runCli(home, ['ask', 'what is the password'], FORCE);
  const log = readFileSync(usageFile(home, 'cli-runs.log'), 'utf8');
  const labels = log
    .trim()
    .split('\n')
    .map((line) => line.split(' ')[1]);
  assert.deepEqual(labels, ['unknown', 'backlog', 'ask']);
  for (const word of ['secret', 'private', 'password']) {
    assert.ok(!log.includes(word), word);
  }
  assertPrivate(home, ['secret', 'private', 'password']);
});

test('commandLabel names a verb only when the command lists it', () => {
  const known = new Set(['agent', 'ask']);
  assert.equal(commandLabel('agent', known, ['start'], 'start'), 'agent.start');
  assert.equal(commandLabel('agent', known, ['start'], 'free text'), 'agent');
  assert.equal(commandLabel('ask', known, undefined, 'a question'), 'ask');
  assert.equal(commandLabel('nope', known, undefined, 'x'), 'unknown');
  assert.equal(commandLabel(undefined, known, undefined, undefined), 'unknown');
});

test('every CLI command has an area, and no area names a command the CLI lacks', () => {
  assert.deepEqual(Object.keys(COMMAND_AREAS).sort(), commandNames().table.slice().sort());
});

test('off: ONCE_UPON_USAGE=0 and `usage off` stop everything; `usage on` and `usage clear` work', async () => {
  const home = tmp('home');
  await runCli(home, ['backlog', 'list'], { ONCE_UPON_USAGE: '0' });
  assert.ok(!existsSync(usageFile(home, 'cli-runs.log')), 'the env switch counts nothing');

  const off = await runCli(home, ['usage', 'off'], FORCE);
  assert.equal(off.code, 0, off.stderr);
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.ok(
    !existsSync(usageFile(home, 'cli-runs.log')),
    'off in the settings file counts nothing',
  );
  const status = await runCli(home, ['usage', 'status'], FORCE);
  assert.match(status.stdout, /Usage capture: off/);

  await runCli(home, ['usage', 'on'], FORCE);
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.ok(existsSync(usageFile(home, 'cli-runs.log')));
  assert.equal(readCoverage(home).files['packages/cli/src/index.ts'][0].mode, 'function');

  const cleared = await runCli(home, ['usage', 'clear'], FORCE);
  assert.equal(cleared.code, 0);
  assert.ok(!existsSync(usageFile(home, 'cli-runs.log')), 'clear removes what was kept');
  assert.ok(!existsSync(usageFile(home, 'coverage-cli.json')));
});

test('lines mode is opt in, and a run in it keeps block ranges', async () => {
  const home = tmp('home');
  await runCli(home, ['usage', 'on', '--lines'], FORCE);
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.equal(readCoverage(home).files['packages/cli/src/index.ts'][0].mode, 'lines');
});

test('C6: a linked worktree is not captured unless forced', async (context) => {
  if (!isLinkedWorktree()) {
    context.skip('these tests run in the main checkout');
    return;
  }
  const home = tmp('home');
  await runCli(home, ['backlog', 'list']);
  assert.ok(!existsSync(usageFile(home, 'cli-runs.log')), 'a worktree run is an agent, not use');
});

test('`usage report` does not count itself and says it has only a little data', async () => {
  const home = tmp('home');
  await runCli(home, ['backlog', 'list'], FORCE);
  const report = await runCli(home, ['usage', 'report', '--no-save'], FORCE);
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /PARTIAL: under a week of data/);
  assert.match(report.stdout, /Window: /);
  assert.equal(readFileSync(usageFile(home, 'cli-runs.log'), 'utf8').trim().split('\n').length, 1);
  const bad = await runCli(home, ['usage', 'report', '--since', 'yesterday'], FORCE);
  assert.notEqual(bad.code, 0);
});

test('fix 1: `usage clear` clears the data and keeps the on/off choice, so off then clear stays off', async () => {
  const home = tmp('home');
  await runCli(home, ['usage', 'off'], FORCE);
  await runCli(home, ['usage', 'clear'], FORCE);
  assert.match((await runCli(home, ['usage', 'status'], FORCE)).stdout, /Usage capture: off/);
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.ok(!existsSync(usageFile(home, 'cli-runs.log')), 'still counts nothing');
  assert.ok(!existsSync(usageFile(home, 'coverage-cli.json')));

  // lines mode survives a clear too, and the data really is gone
  await runCli(home, ['usage', 'on', '--lines'], FORCE);
  await runCli(home, ['backlog', 'list'], FORCE);
  assert.ok(existsSync(usageFile(home, 'cli-runs.log')));
  await runCli(home, ['usage', 'clear'], FORCE);
  assert.ok(!existsSync(usageFile(home, 'cli-runs.log')));
  assert.match((await runCli(home, ['usage', 'status'], FORCE)).stdout, /line level/);
});
