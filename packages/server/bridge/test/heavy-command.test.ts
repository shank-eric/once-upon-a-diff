/** `once-upon heavy`: one lock, taken in turn, never held by a dead process, in a lock folder a test picks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
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
  const release = path.join(dir, 'release');
  const env = lockEnv(lock);
  // the first holds the lock until the test creates `release`, so no fixed time decides who is waiting
  const first = runCli(
    home(),
    [
      'heavy',
      'first',
      'sh',
      '-c',
      `echo first-start >> ${order}; while [ ! -e ${release} ]; do sleep 0.05; done; echo first-end >> ${order}`,
    ],
    env,
  );
  let passed = false;
  let child: ReturnType<typeof spawn> | undefined;
  let ended: Promise<number | null> | undefined;
  try {
    assert.ok(await until(() => existsSync(order), 20000), 'the first run holds the lock');
    assert.match(readFileSync(`${lock}.who`, 'utf8'), /^first \(\d{1,2}:\d{2} [AP]M\): sh -c/);
    const second = spawn(
      process.execPath,
      [CLI_BIN, 'heavy', 'second', 'sh', '-c', `echo second >> ${order}`],
      {
        env: { ...process.env, ONCE_UPON_HOME: home(), ...lockEnv(lock) },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child = second;
    let stderr = '';
    second.stderr.on('data', (chunk) => (stderr += chunk));
    ended = new Promise<number | null>((resolve) => second.on('close', (code) => resolve(code)));
    assert.ok(await until(() => /waiting for first/.test(stderr), 20000), 'the second run waits');
    assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), ['first-start']);
    passed = true;
  } finally {
    writeFileSync(release, '');
    if (!passed && child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  assert.ok(ended);
  assert.equal(await ended, 0);
  await first;
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), [
    'first-start',
    'first-end',
    'second',
  ]);
});

test('with no override the lock is ~/.cache/heavy-run.lock, or under XDG_CACHE_HOME', async () => {
  const userHome = tmp('heavy-user');
  const base = { HOME: userHome, ONCE_UPON_HEAVY_LOCK: '', XDG_CACHE_HOME: '' };
  const seen = await runCli(
    home(),
    ['heavy', 'x', 'sh', '-c', 'cat "$HOME/.cache/heavy-run.lock.who"'],
    base,
  );
  assert.match(seen.stdout, /^x \(/);
  const xdg = tmp('heavy-xdg');
  const viaXdg = await runCli(
    home(),
    ['heavy', 'y', 'sh', '-c', `cat "${xdg}/heavy-run.lock.who"`],
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

test('--lane browser runs on its own lock, beside a held main lock, and frees it', async () => {
  const dir = tmp('heavy');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, 'full suite\n');
  const env = lockEnv(lock);
  const ok = await runCli(home(), ['heavy', '--lane', 'browser', 'one', 'echo', 'ran'], env);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), 'ran');
  assert.equal(ok.stderr, '');
  assert.equal(existsSync(`${lock}-browser`), false);
  assert.equal(existsSync(`${lock}-browser.who`), false);
  const inside = await runCli(
    home(),
    ['heavy', '--lane', 'browser', 'one', 'sh', '-c', `cat "${lock}-browser.who"`],
    env,
  );
  assert.match(inside.stdout, /^one \(/);
  const equals = await runCli(home(), ['heavy', '--lane=browser', 'one', '--', 'echo', 'ran'], env);
  assert.equal(equals.code, 0);
  assert.equal(equals.stdout.trim(), 'ran');
});

test("--lane takes only browser, with a name and a command; after the name it stays the command's own flag", async () => {
  const env = lockEnv(path.join(tmp('heavy'), 'lock'));
  for (const args of [
    ['--lane', 'nope', 'one', 'echo', 'ran'],
    ['--lane'],
    ['--lane', 'browser'],
    ['--lane', 'browser', 'one'],
    ['--lane=', 'one', 'echo', 'ran'],
    ['--lane=nope', 'one', 'echo', 'ran'],
  ]) {
    const run = await runCli(home(), ['heavy', ...args], env);
    assert.equal(run.code, 1, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
    assert.match(run.stderr, /usage: once-upon heavy \[--lane browser\] NAME COMMAND/);
  }
  const own = await runCli(home(), ['heavy', 'one', 'echo', '--lane', 'browser'], env);
  assert.equal(own.stdout, '--lane browser\n');
});

test('deploy takes no lane: it is a usage error and nothing runs', async () => {
  const env = lockEnv(path.join(tmp('heavy'), 'lock'));
  for (const args of [
    ['--lane', 'browser', 'one', 'echo', 'ran'],
    ['--lane=browser', 'one', 'echo', 'ran'],
  ]) {
    const run = await runCli(home(), ['deploy', ...args], env);
    assert.equal(run.code, 1, args.join(' '));
    assert.doesNotMatch(run.stdout, /^ok /);
    assert.match(run.stderr, /usage: once-upon deploy/);
  }
});

test('with no override the browser lane lock is ~/.cache/heavy-run-browser.lock, or under XDG_CACHE_HOME, or ONCE_UPON_HEAVY_LOCK_BROWSER', async () => {
  const userHome = tmp('heavy-user');
  const base = { HOME: userHome, ONCE_UPON_HEAVY_LOCK: '', XDG_CACHE_HOME: '' };
  const seen = await runCli(
    home(),
    [
      'heavy',
      '--lane',
      'browser',
      'x',
      'sh',
      '-c',
      'cat "$HOME/.cache/heavy-run-browser.lock.who"',
    ],
    base,
  );
  assert.match(seen.stdout, /^x \(/);
  const xdg = tmp('heavy-xdg');
  const viaXdg = await runCli(
    home(),
    ['heavy', '--lane', 'browser', 'y', 'sh', '-c', `cat "${xdg}/heavy-run-browser.lock.who"`],
    { ...base, XDG_CACHE_HOME: xdg },
  );
  assert.match(viaXdg.stdout, /^y \(/);
  const own = path.join(tmp('heavy-own'), 'lane');
  const viaEnv = await runCli(
    home(),
    ['heavy', '--lane', 'browser', 'z', 'sh', '-c', `cat "${own}.who"`],
    {
      ...base,
      ONCE_UPON_HEAVY_LOCK: path.join(tmp('heavy'), 'main'),
      ONCE_UPON_HEAVY_LOCK_BROWSER: own,
    },
  );
  assert.match(viaEnv.stdout, /^z \(/);
});

// The `heavy` progress line: one per heavy command, the wait in it, and no beat on the agent's run.

/** A home whose progress file is `progress`, with a registered author `name` that has beaten 3/6 `code`. */
async function progressHome(name: string, progress: string) {
  const dir = tmp('heavy-home');
  writeJson(path.join(dir, 'config.json'), { board_progress_file: progress });
  const sid = 'abcdef01';
  const start = ['agent', 'start', name, '--kind', 'helper', '--task', 'x', '--sid', sid];
  assert.equal((await runCli(dir, start)).code, 0);
  assert.equal((await runCli(dir, ['beat', name, '3/6', 'code', '--sid', sid])).code, 0);
  return dir;
}

test('a heavy command leaves one `heavy` line in the progress file and leaves the run’s own step alone', async () => {
  const progress = path.join(tmp('heavy-out'), 'progress.md');
  const dir = await progressHome('author-a', progress);
  const env = lockEnv(path.join(tmp('heavy'), 'lock'));
  const run = await runCli(dir, ['heavy', 'author-a', 'echo', 'ran'], env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'ran\n');
  const lines = readFileSync(progress, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'the beat and the heavy line');
  assert.match(
    lines[1],
    /^- \d{1,2}:\d{2} [AP]M author-a 3\/6 heavy: ran "echo ran" with no wait$/,
  );
  const beat = new AgentRegistry(dir).agents().find((one) => one.name === 'author-a')?.beat;
  assert.deepEqual([beat?.n, beat?.step], [3, 'code'], 'the run’s step is still its own');
});

test('a name with no open run (a deploy) still gets its line, as 1/1, and a deploy prints only its one line', async () => {
  const progress = path.join(tmp('heavy-out'), 'progress.md');
  const dir = tmp('heavy-home');
  writeJson(path.join(dir, 'config.json'), { board_progress_file: progress });
  const run = await runCli(
    dir,
    ['deploy', 'ship', 'true'],
    lockEnv(path.join(tmp('heavy'), 'lock')),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.match(run.stdout, /^ok \S+\n$/);
  assert.match(
    readFileSync(progress, 'utf8'),
    /^- \d{1,2}:\d{2} [AP]M ship 1\/1 heavy: ran "true" with no wait\n$/,
  );
});

test('a run that waited has the seconds and the position in its line', async () => {
  const progress = path.join(tmp('heavy-out'), 'progress.md');
  const dir = tmp('heavy-home');
  writeJson(path.join(dir, 'config.json'), { board_progress_file: progress });
  const lock = path.join(tmp('heavy'), 'lock');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, `other (3:40 PM): yarn test\npid ${process.pid}\n`);
  const run = runCli(dir, ['heavy', 'late', 'true'], lockEnv(lock));
  try {
    assert.ok(
      await until(() => existsSync(`${lock}-waiters`), 20000),
      'the run waits for the lock',
    );
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(`${lock}.who`, { force: true });
  }
  assert.equal((await run).code, 0);
  assert.match(
    readFileSync(progress, 'utf8'),
    /late 1\/1 heavy: ran "true" after waiting \d+ s \(position 1, behind other \(3:40 PM\): yarn test\)\n$/,
  );
});
