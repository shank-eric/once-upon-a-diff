/** `once-upon deploy`: the deploy command runs through the heavy lock, its output goes to a log, and one line says how it went. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runCli, tmp } from './helpers.ts';
import { until } from './script-helpers.ts';

const lockEnv = () => ({
  ONCE_UPON_HEAVY_LOCK: path.join(tmp('deploy-lock'), 'lock'),
  ONCE_UPON_HEAVY_POLL: '0.1',
});

/** The one line a run prints: `ok <log>` or `failed <log>`. */
function result(stdout: string): { word: string; log: string } {
  assert.equal(stdout.trimEnd().split('\n').length, 1, `one line, got: ${stdout}`);
  const match = /^(ok|failed) (\S+)\n$/.exec(stdout);
  assert.ok(match, `ok or failed, then the log path: ${stdout}`);
  return { word: match[1], log: match[2] };
}

test('a passing command prints one ok line, and the log holds all its output', async () => {
  const home = tmp('deploy-home');
  const dir = tmp('deploy-cwd');
  const run = await runCli(
    home,
    ['deploy', 'ship', 'sh', '-c', 'echo built; echo warn >&2; pwd'],
    lockEnv(),
    dir,
  );
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '', 'nothing on stderr');
  const { word, log } = result(run.stdout);
  assert.equal(word, 'ok');
  assert.ok(path.isAbsolute(log) && existsSync(log));
  const text = readFileSync(log, 'utf8');
  assert.match(text, /built\n/);
  assert.match(text, /warn\n/);
  assert.match(text, new RegExp(path.basename(dir)), 'the command ran in the caller folder');
});

test('a failing command prints one failed line, exits with its code, and the log holds its output', async () => {
  const run = await runCli(
    tmp('deploy-home'),
    ['deploy', 'ship', 'sh', '-c', 'echo gate one; echo gate two failed >&2; exit 3'],
    lockEnv(),
  );
  assert.equal(run.code, 3);
  assert.equal(run.stderr, '', 'nothing on stderr');
  const { word, log } = result(run.stdout);
  assert.equal(word, 'failed');
  assert.equal(readFileSync(log, 'utf8'), 'gate one\ngate two failed\n');
});

test("the command's own flags stay its own, a command that cannot start is failed, and a missing command is a usage error", async () => {
  const env = lockEnv();
  const flags = await runCli(
    tmp('deploy-home'),
    ['deploy', 'ship', 'echo', '--yes', '--batch', 'main'],
    env,
  );
  assert.equal(readFileSync(result(flags.stdout).log, 'utf8'), '--yes --batch main\n');
  const missing = await runCli(tmp('deploy-home'), ['deploy', 'ship', 'no-such-program-xyz'], env);
  assert.equal(missing.code, 127);
  assert.equal(missing.stderr, '', 'nothing on stderr when the command cannot start');
  const missingResult = result(missing.stdout);
  assert.equal(missingResult.word, 'failed');
  assert.match(readFileSync(missingResult.log, 'utf8'), /can't run no-such-program-xyz/);
  assert.equal((await runCli(tmp('deploy-home'), ['deploy'], env)).code, 1);
  assert.equal((await runCli(tmp('deploy-home'), ['deploy', 'ship'], env)).code, 1);
});

test('waiting for a busy lock is noted in the log, not on the terminal', async () => {
  const env = lockEnv();
  const lock = env.ONCE_UPON_HEAVY_LOCK;
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), String(process.pid));
  writeFileSync(path.join(lock, 'who'), 'other (3:40 PM): yarn test');
  const home = tmp('deploy-home');
  const run = runCli(home, ['deploy', 'ship', 'echo', 'hi'], env);
  try {
    // the lock stays until the run's log says it is waiting, so no fixed time decides it
    const logs = path.join(home, 'logs');
    const waiting = () =>
      existsSync(logs) &&
      readdirSync(logs).some((file) =>
        /once-upon heavy: waiting for/.test(readFileSync(path.join(logs, file), 'utf8')),
      );
    assert.ok(await until(waiting, 20000), 'the run waits for the lock');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  const done = await run;
  assert.equal(done.code, 0);
  assert.equal(done.stderr, '', 'nothing on stderr');
  const text = readFileSync(result(done.stdout).log, 'utf8');
  assert.match(text, /once-upon heavy: waiting for other \(3:40 PM\): yarn test\nhi\n/);
});

test('a NAME that is not a plain agent name is refused before anything is written, and the log is owner-only', async () => {
  const home = tmp('deploy-home');
  const dir = tmp('deploy-cwd');
  for (const name of ['a b/../../../escape', '../escape', 'a/b', 'a b']) {
    const run = await runCli(home, ['deploy', name, 'true'], lockEnv(), dir);
    assert.equal(run.code, 1, name);
    assert.equal(run.stdout, '', name);
    assert.match(run.stderr, /usage: once-upon deploy NAME COMMAND/, name);
  }
  assert.equal(existsSync(path.join(home, 'logs')), false, 'no log folder was made');
  assert.equal(existsSync(path.join(home, '..', 'escape')), false);
  const ok = await runCli(home, ['deploy', 'ship', 'true'], lockEnv(), dir);
  const { log } = result(ok.stdout);
  assert.equal(path.dirname(log), path.join(home, 'logs'));
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(log)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(path.join(home, 'logs')).length, 1);
});
