/**
 * The heavy-run lock: a fresh lock is waited for and named, a crashed holder's lock is taken over, a live holder is never
 * taken from however long it runs, waiters never run together, and what earlier versions left at the lock path is dealt with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { heavyHolders, runHeavy } from '../src/heavy-lock.ts';

const heavyLockModule = new URL('../src/heavy-lock.ts', import.meta.url).href;

const deadPid = () =>
  Number(
    spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout,
  );
const lockEnv = (lock: string) => ({
  ...process.env,
  ONCE_UPON_HEAVY_LOCK: lock,
  ONCE_UPON_HEAVY_POLL: '0.05',
});
const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));
const ageOf = (file: string, seconds: number) => {
  const old = new Date(Date.now() - seconds * 1000);
  utimesSync(file, old, old);
};

test('a fresh lock is waited for and its holder named once; the run goes when the holder lets go', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, 'first waiter\n');
  const lines: string[] = [];
  let finished = false;
  const run = runHeavy('second', ['true'], (line) => lines.push(line), lockEnv(lock)).then(
    (code) => {
      finished = true;
      return code;
    },
  );
  await pause(400);
  assert.equal(finished, false);
  assert.deepEqual(lines, ['once-upon heavy: waiting for first waiter']);
  rmdirSync(lock); // the holder lets go: the second runs
  assert.equal(await run, 0);
  assert.deepEqual(readdirSync(dir), [], 'the lock and its name are gone');
});

test('a name left beside the lock by a crashed holder is not believed: it is older than the lock folder', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  writeFileSync(`${lock}.who`, 'crashed\n');
  ageOf(`${lock}.who`, 5);
  mkdirSync(lock); // another holder has it now, and has not written its name yet
  const lines: string[] = [];
  const run = runHeavy('waiter', ['true'], (line) => lines.push(line), lockEnv(lock));
  await pause(300);
  rmdirSync(lock);
  assert.equal(await run, 0);
  assert.deepEqual(lines, ['once-upon heavy: waiting for another heavy run']);
});

test('a lock nobody has touched for longer than the stale age is a crashed holder’s and is taken over', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  ageOf(lock, 120);
  assert.equal(await runHeavy('one', ['true'], () => {}, lockEnv(lock)), 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a live holder is never taken from however long it runs: its lock is kept fresh past the stale age', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  const env = { ...lockEnv(lock), ONCE_UPON_HEAVY_STALE_MS: '2000' };
  const order: string[] = [];
  const holder = runHeavy(
    'holder',
    [process.execPath, '-e', 'setTimeout(() => {}, 4500)'],
    () => {},
    env,
  ).then((code) => {
    order.push('holder');
    return code;
  });
  while (!existsSync(`${lock}.who`)) {
    await pause(20);
  }
  const waiter = runHeavy('waiter', ['true'], () => {}, env).then((code) => {
    order.push('waiter');
    return code;
  });
  assert.deepEqual(await Promise.all([holder, waiter]), [0, 0]);
  assert.deepEqual(
    order,
    ['holder', 'waiter'],
    'the waiter waited out the holder, 2 s stale or not',
  );
  assert.deepEqual(readdirSync(dir), []);
});

/** Runs a node script in a child under a hard timeout, and resolves to its exit code, stdout and stderr. */
function child(script: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

// Waits for the go time, then runs a command holding the lock that fails if another holder is inside.
const CONTEND = `
import { runHeavy } from ${JSON.stringify(heavyLockModule)};
const [lock, inside, goAt] = process.argv.slice(1);
const section = \`const fs = require('node:fs');
fs.mkdirSync(process.argv[1]);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.rmdirSync(process.argv[1]);\`;
while (Date.now() < Number(goAt)) {}
const env = { ...process.env, ONCE_UPON_HEAVY_LOCK: lock, ONCE_UPON_HEAVY_POLL: '0.01' };
process.exit(await runHeavy('contender', [process.execPath, '-e', section, inside], () => {}, env));
`;

test('waiters that queue for one lock at once never run together', async () => {
  for (let trial = 0; trial < 4; trial++) {
    const dir = tmp('heavy-lock');
    const lock = path.join(dir, 'lock');
    const goAt = String(Date.now() + 500);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        child(CONTEND, [lock, path.join(dir, 'inside'), goAt], 60_000),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0, `trial ${trial}: ${run.err}`);
    }
    assert.deepEqual(readdirSync(dir), [], `trial ${trial}: nothing left behind`);
  }
});

// What earlier versions left at the lock path.

test('a lock folder as an earlier version made it is taken over when its pid is gone', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
  writeFileSync(path.join(lock, 'who'), 'gone (1:00 PM): yarn test\n');
  assert.equal(await runHeavy('one', ['true'], () => {}, lockEnv(lock)), 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('an earlier version’s lock folder with a live pid is waited for, however old, and named', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  writeFileSync(path.join(lock, 'who'), 'old holder (1:00 PM): yarn test\n');
  ageOf(lock, 600);
  const lines: string[] = [];
  let finished = false;
  const run = runHeavy('new', ['true'], (line) => lines.push(line), lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(400);
  assert.equal(finished, false);
  assert.deepEqual(lines, ['once-upon heavy: waiting for old holder (1:00 PM): yarn test']);
  rmSync(lock, { recursive: true }); // the old holder lets go
  assert.equal(await run, 0);
});

test('an earlier version’s lock folder with a name and no pid is waited for while fresh and taken over once old', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'who'), 'died early\n');
  let finished = false;
  const run = runHeavy('new', ['true'], () => {}, lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(400);
  assert.equal(finished, false, 'it may be a holder about to write its pid');
  ageOf(lock, 61);
  assert.equal(await run, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a lock folder with no files in it is waited for while fresh and taken over once it is older than the stale age', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  const lines: string[] = [];
  let finished = false;
  const run = runHeavy('one', ['true'], (line) => lines.push(line), lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(400);
  assert.equal(finished, false);
  assert.deepEqual(lines, ['once-upon heavy: waiting for another heavy run']);
  ageOf(lock, 61);
  assert.equal(await run, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a file left at the lock path is cleared once it is old, and a fresh one is waited for', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  writeFileSync(lock, 'x');
  const started = Date.now();
  assert.equal(
    await runHeavy('one', ['true'], () => {}, lockEnv(lock)),
    0,
    'the fresh file ages out',
  );
  assert.ok(Date.now() - started >= 1500, 'a fresh file was waited for');
  writeFileSync(lock, 'x');
  ageOf(lock, 120);
  const again = Date.now();
  assert.equal(await runHeavy('two', ['true'], () => {}, lockEnv(lock)), 0);
  assert.ok(Date.now() - again < 1000, 'an old file is cleared at once');
  assert.deepEqual(readdirSync(dir), []);
});

test(
  'a lock folder that cannot be made fails the run at once instead of polling for ever',
  { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false },
  async () => {
    const dir = tmp('heavy-lock');
    chmodSync(dir, 0o500);
    try {
      const started = Date.now();
      await assert.rejects(
        runHeavy('one', ['true'], () => {}, lockEnv(path.join(dir, 'lock'))),
        { code: 'EACCES' },
      );
      assert.ok(Date.now() - started < 1000);
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

// Holds the heavy lock for a few seconds, running a command that leaves a file when it ends.
const HOLD = `
import { runHeavy } from ${JSON.stringify(heavyLockModule)};
const [lock, ended] = process.argv.slice(1);
const command = \`setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 1000)\`;
const env = { ...process.env, ONCE_UPON_HEAVY_LOCK: lock, ONCE_UPON_HEAVY_POLL: '0.05', ONCE_UPON_HEAVY_STALE_MS: '2000' };
process.exit(await runHeavy('holder', [process.execPath, '-e', command, ended], () => {}, env));
`;

test('a holder that stalled past the stale age but still runs (the Mac slept) is not taken from; a dead one is', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  const ended = path.join(dir, 'ended');
  const env = { ...lockEnv(lock), ONCE_UPON_HEAVY_STALE_MS: '2000' };
  const holder = child(HOLD, [lock, ended], 30_000);
  while (!existsSync(`${lock}.who`) || !readFileSync(`${lock}.who`, 'utf8').includes('pid ')) {
    await pause(20);
  }
  const pid = Number(/^pid (\d+)$/m.exec(readFileSync(`${lock}.who`, 'utf8'))?.[1]);
  process.kill(pid, 'SIGSTOP'); // its refresh stops, like a sleeping Mac's
  let sawEnded: boolean | null = null;
  try {
    const waiter = runHeavy(
      'waiter',
      [
        process.execPath,
        '-e',
        'process.exit(require("node:fs").existsSync(process.argv[1]) ? 0 : 1)',
        ended,
      ],
      () => {},
      env,
    ).then((code) => {
      sawEnded = code === 0;
      return code;
    });
    await pause(3500); // well past the 2 s stale age: the holder's folder is stale by age, its pid is alive
    assert.equal(sawEnded, null, 'the waiter did not start while the stalled holder was alive');
    process.kill(pid, 'SIGCONT');
    assert.equal(await waiter, 0, 'the waiter ran after the holder ended');
  } finally {
    try {
      process.kill(pid, 'SIGCONT');
    } catch {
      // gone
    }
  }
  assert.equal((await holder).code, 0);
  assert.deepEqual(readdirSync(dir).sort(), ['ended']);
});

test('a stale lock whose holder’s pid is dead is taken over', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, `crashed\npid ${deadPid()}\n`);
  ageOf(lock, 120);
  assert.equal(await runHeavy('one', ['true'], () => {}, lockEnv(lock)), 0);
  assert.deepEqual(readdirSync(dir), []);
});

// The browser lane: its own one-at-a-time lock (`<main lock>-browser` when a test sets only the main one).

test('a browser-lane run goes while the main lock is held, and a main-lane run still waits', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, 'full suite\n');
  const lines: string[] = [];
  assert.equal(
    await runHeavy(
      'spec',
      ['true'],
      (line) => lines.push(line),
      lockEnv(lock),
      undefined,
      'browser',
    ),
    0,
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(readdirSync(dir).sort(), ['lock', 'lock.who'], 'the lane left nothing behind');
  let finished = false;
  const main = runHeavy('main', ['true'], () => {}, lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(300);
  assert.equal(finished, false, 'the main lock is still held');
  rmdirSync(lock);
  assert.equal(await main, 0);
});

test('the main lock does not wait on a browser-lane run', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  mkdirSync(`${lock}-browser`);
  writeFileSync(`${lock}-browser.who`, 'a spec\n');
  assert.equal(await runHeavy('main', ['true'], () => {}, lockEnv(lock)), 0);
  rmdirSync(`${lock}-browser`);
});

test('two browser-lane runs take turns, and the second names the lane while it waits', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  const order = path.join(dir, 'order.txt');
  const release = path.join(dir, 'release');
  const shell = (script: string) => ['sh', '-c', script];
  const first = runHeavy(
    'first',
    shell(
      `echo first-start >> ${order}; while [ ! -e ${release} ]; do sleep 0.02; done; echo first-end >> ${order}`,
    ),
    () => {},
    lockEnv(lock),
    undefined,
    'browser',
  );
  try {
    for (let waited = 0; !existsSync(order) && waited < 200; waited++) {
      await pause(50);
    }
    assert.ok(existsSync(order), 'the first holds the lane');
    const lines: string[] = [];
    const second = runHeavy(
      'second',
      shell(`echo second >> ${order}`),
      (line) => lines.push(line),
      lockEnv(lock),
      undefined,
      'browser',
    );
    await pause(400);
    assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), ['first-start']);
    assert.match(lines.join('\n'), /^once-upon heavy \(browser lane\): waiting for first \(/);
    writeFileSync(release, '');
    assert.equal(await second, 0);
  } finally {
    writeFileSync(release, '');
  }
  assert.equal(await first, 0);
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), [
    'first-start',
    'first-end',
    'second',
  ]);
  assert.deepEqual(readdirSync(dir).sort(), ['order.txt', 'release']);
});

test('heavyHolders names the live holder of the main lock and of the browser lane, and no one once it lets go', async () => {
  const dir = tmp('heavy-holders');
  const lock = path.join(dir, 'lock');
  const env = lockEnv(lock);
  assert.deepEqual([...heavyHolders(env)], [], 'no lock, no holder');
  mkdirSync(lock);
  writeFileSync(`${lock}.who`, `fix-login (3:40 PM): yarn test\npid ${process.pid}\n`);
  mkdirSync(`${lock}-browser`);
  writeFileSync(
    `${lock}-browser.who`,
    `check-ui (3:41 PM): yarn test:extension\npid ${process.pid}\n`,
  );
  assert.deepEqual([...heavyHolders(env)].sort(), ['check-ui', 'fix-login']);
  writeFileSync(`${lock}.who`, `crashed (3:40 PM): yarn test\npid ${deadPid()}\n`);
  assert.deepEqual(
    [...heavyHolders(env)],
    ['check-ui'],
    'a holder whose process is gone is no holder',
  );
  writeFileSync(`${lock}.who`, 'first waiter\n');
  assert.deepEqual([...heavyHolders(env)], ['check-ui'], 'a who with no pid is not believed');
});
