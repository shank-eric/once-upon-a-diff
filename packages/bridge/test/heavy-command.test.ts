/** `once-upon heavy`: one lock, taken in turn, never held by a dead process, in a lock folder a test picks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp } from './helpers.ts';
import { CLI_BIN, until } from './script-helpers.ts';

const home = () => tmp('heavy-home');
const lockEnv = (lock: string) => ({ ONCE_UPON_HEAVY_LOCK: lock, ONCE_UPON_HEAVY_POLL: '0.1' });

test('it runs the command, passes its exit code and frees the lock', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  const env = lockEnv(lock);
  const ok = await runCli(home(), ['heavy', 'one', 'echo', 'ran'], env);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), 'ran');
  assert.equal(existsSync(lock), false);
  const failed = await runCli(home(), ['heavy', 'one', 'sh', '-c', 'exit 3'], env);
  assert.equal(failed.code, 3);
  assert.equal(existsSync(lock), false);
});

test("the command's own flags stay its own, with or without a -- before it", async () => {
  const env = lockEnv(path.join(tmp('heavy'), 'lock'));
  const plain = await runCli(home(), ['heavy', 'one', 'echo', '--batch', '-n', 'x'], env);
  assert.equal(plain.stdout, '--batch -n x\n');
  const dashed = await runCli(home(), ['heavy', 'one', '--', 'echo', '--batch'], env);
  assert.equal(dashed.stdout, '--batch\n');
});

test('a missing name or command is a usage error; a command that cannot start is 127 and frees the lock', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  const env = lockEnv(lock);
  assert.equal((await runCli(home(), ['heavy'], env)).code, 1);
  assert.equal((await runCli(home(), ['heavy', 'one'], env)).code, 1);
  const missing = await runCli(home(), ['heavy', 'one', 'no-such-program-xyz'], env);
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /can't run no-such-program-xyz/);
  assert.equal(existsSync(lock), false);
});

test('a second run waits for the first and runs after it', async () => {
  const dir = tmp('heavy');
  const lock = path.join(dir, 'lock');
  const order = path.join(dir, 'order.txt');
  const env = lockEnv(lock);
  const first = runCli(
    home(),
    [
      'heavy',
      'first',
      'sh',
      '-c',
      `echo first-start >> ${order}; sleep 1; echo first-end >> ${order}`,
    ],
    env,
  );
  assert.ok(await until(() => existsSync(order)), 'the first run holds the lock');
  assert.match(
    readFileSync(path.join(lock, 'who'), 'utf8'),
    /^first \(\d{1,2}:\d{2} [AP]M\): sh -c/,
  );
  assert.equal(Number(readFileSync(path.join(lock, 'pid'), 'utf8')) > 0, true);
  const second = await runCli(
    home(),
    ['heavy', 'second', 'sh', '-c', `echo second >> ${order}`],
    env,
  );
  await first;
  assert.match(second.stderr, /waiting for first/);
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), [
    'first-start',
    'first-end',
    'second',
  ]);
});

test('a lock folder as the old shell script left it (pid, who) holds the run until its pid is gone', async () => {
  const dir = tmp('heavy');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  writeFileSync(path.join(lock, 'who'), 'old-script (3:40 PM): yarn test\n');
  let finished = false;
  const waiting = runCli(home(), ['heavy', 'x', 'echo', 'ran'], lockEnv(lock)).then((run) => {
    finished = true;
    return run;
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(finished, false, 'the live holder keeps it waiting');
  writeFileSync(path.join(lock, 'pid'), '999999999\n'); // the holder is gone
  const run = await waiting;
  assert.equal(run.stdout.trim(), 'ran');
  assert.match(run.stderr, /waiting for old-script \(3:40 PM\): yarn test/);
  assert.equal(existsSync(lock), false);
});

test('a lock held by a pid that is gone is taken over without a word', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), '999999999');
  const run = await runCli(home(), ['heavy', 'x', 'echo', 'ran'], lockEnv(lock));
  assert.equal(run.stdout.trim(), 'ran');
  assert.equal(run.stderr, '');
});

test('with no override the lock is ~/.cache/heavy-run.lock, or under XDG_CACHE_HOME', async () => {
  const userHome = tmp('heavy-user');
  const base = { HOME: userHome, ONCE_UPON_HEAVY_LOCK: '', XDG_CACHE_HOME: '' };
  const seen = await runCli(
    home(),
    ['heavy', 'x', 'sh', '-c', 'cat "$HOME/.cache/heavy-run.lock/who"'],
    base,
  );
  assert.match(seen.stdout, /^x \(/);
  const xdg = tmp('heavy-xdg');
  const viaXdg = await runCli(
    home(),
    ['heavy', 'y', 'sh', '-c', `cat "${xdg}/heavy-run.lock/who"`],
    { ...base, XDG_CACHE_HOME: xdg },
  );
  assert.match(viaXdg.stdout, /^y \(/);
});

test('ONCE_UPON_PATH, when set, is the PATH the command gets and is not passed on; unset or empty leaves PATH alone', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  const probe = 'printf "%s|%s" "$PATH" "${ONCE_UPON_PATH-unset}"';
  const set = await runCli(home(), ['heavy', 'x', 'sh', '-c', probe], {
    ...lockEnv(lock),
    ONCE_UPON_PATH: '/usr/bin:/bin',
  });
  assert.equal(set.stdout, '/usr/bin:/bin|unset');
  // the program itself is found on that PATH too
  const found = await runCli(home(), ['heavy', 'x', 'sh', '-c', 'command -v ls'], {
    ...lockEnv(lock),
    ONCE_UPON_PATH: '/usr/bin:/bin',
  });
  assert.equal(found.stdout.trim(), '/bin/ls');
  for (const value of ['', undefined]) {
    const env: Record<string, string> = lockEnv(lock);
    if (value !== undefined) {
      env.ONCE_UPON_PATH = value;
    }
    const run = await runCli(home(), ['heavy', 'x', 'sh', '-c', probe], env);
    assert.equal(run.stdout, `${process.env.PATH}|unset`);
  }
});

test("the command gets the caller's umask, not the CLI's own 0077", async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  const shell = `umask 022; ${process.execPath} ${CLI_BIN} heavy x sh -c 'umask; echo "[$ONCE_UPON_CALLER_UMASK]"'`;
  const run = await new Promise<string>((resolve) =>
    execFile(
      'sh',
      ['-c', shell],
      { env: { ...process.env, ONCE_UPON_HOME: home(), ...lockEnv(lock) } },
      (_err, stdout) => resolve(stdout),
    ),
  );
  assert.equal(run, '0022\n[]\n');
});

test('SIGTERM goes on to the command, the run ends 128 + 15 and the lock is freed', async () => {
  const dir = tmp('heavy');
  const lock = path.join(dir, 'lock');
  const started = path.join(dir, 'started');
  const child = spawn(
    process.execPath,
    [CLI_BIN, 'heavy', 'sig', 'sh', '-c', `echo up > ${started}; sleep 30`],
    { env: { ...process.env, ONCE_UPON_HOME: home(), ...lockEnv(lock) }, stdio: 'ignore' },
  );
  const ended = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  assert.ok(await until(() => existsSync(started), 20000), 'the command is running');
  child.kill('SIGTERM');
  assert.equal(await ended, 143);
  assert.equal(existsSync(lock), false);
});
