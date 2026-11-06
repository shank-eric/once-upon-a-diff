/** The heavy-run lock's stale takeovers: a live lock is never moved or removed, one reaper at a time, and a lock with no pid ages out. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { runHeavy, takeoverSeam } from '../src/heavy-lock.ts';

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

test('a waiter that judged a dead holder stale leaves the lock another waiter took over meanwhile alone', async () => {
  const lock = path.join(tmp('heavy-lock'), 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
  const lines: string[] = [];
  // after this waiter judged the dead lock stale, another took it over: a live holder (this process) has a fresh one
  takeoverSeam.beforeRemove = () => {
    takeoverSeam.beforeRemove = null;
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
    writeFileSync(path.join(lock, 'who'), 'first waiter\n');
  };
  try {
    const second = runHeavy('second', ['true'], (line) => lines.push(line), lockEnv(lock));
    await pause(400);
    assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(process.pid));
    assert.deepEqual(lines, ['once-upon heavy: waiting for first waiter']);
    assert.deepEqual(
      readdirSync(path.dirname(lock)).filter((name) => name !== 'lock'),
      [],
      'nothing left moved aside',
    );
    rmSync(lock, { recursive: true }); // the holder lets go: the second runs
    assert.equal(await second, 0);
    assert.equal(existsSync(lock), false);
  } finally {
    takeoverSeam.beforeRemove = null;
  }
});

test('a lock left by a gone process is taken over at once', async () => {
  const lock = path.join(tmp('heavy-lock'), 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
  assert.equal(await runHeavy('one', ['true'], () => {}, lockEnv(lock)), 0);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(path.dirname(lock)), [], 'nothing left moved aside');
});

test('a lock with no pid is waited for while fresh and taken over once it is older than a minute', async () => {
  const lock = path.join(tmp('heavy-lock'), 'lock');
  mkdirSync(lock);
  const lines: string[] = [];
  let finished = false;
  const run = runHeavy('one', ['true'], (line) => lines.push(line), lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(400);
  assert.equal(finished, false, 'a fresh lock with no pid may be a holder about to write it');
  assert.deepEqual(lines, ['once-upon heavy: waiting for another heavy run']);
  const old = new Date(Date.now() - 61_000);
  utimesSync(lock, old, old);
  assert.equal(await run, 0);
  assert.equal(existsSync(lock), false);
});

const ageOf = (file: string, seconds: number) => {
  const old = new Date(Date.now() - seconds * 1000);
  utimesSync(file, old, old);
};

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

// Counts the moments the lock path was empty while the file `flag` said a live holder had it.
const WATCH_EMPTY = `
import { existsSync, readFileSync } from 'node:fs';
const [lock, flag, stop] = process.argv.slice(1);
const read = () => { try { return readFileSync(flag, 'utf8'); } catch { return ''; } };
let seen = 0;
while (!existsSync(stop)) {
  const before = read();
  if (before && !existsSync(lock) && read() === before) seen++;
}
process.stdout.write(String(seen));
`;

test('a reap that races a live holder never moves its lock aside, so the lock path is never empty', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  const flag = path.join(dir, 'live');
  const stop = path.join(dir, 'stop');
  const watcher = child(WATCH_EMPTY, [lock, flag, stop], 60_000);
  let attempt = 0;
  let armed = false;
  // after each waiter judged the dead lock stale, another took it over: a live holder (this process) writes its pid in place
  takeoverSeam.beforeRemove = () => {
    if (!armed) {
      return;
    }
    armed = false;
    writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
    writeFileSync(flag, String(attempt));
  };
  try {
    for (attempt = 1; attempt <= 60; attempt++) {
      mkdirSync(lock);
      writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
      armed = true;
      let waiting!: () => void;
      const heard = new Promise<void>((resolve) => (waiting = resolve));
      const run = runHeavy('waiter', ['true'], waiting, {
        ...lockEnv(lock),
        ONCE_UPON_HEAVY_POLL: '0.01',
      });
      await heard; // it judged the lock stale, found it live under the guard and left it
      assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(process.pid));
      rmSync(flag);
      writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`); // the holder is gone: the waiter takes over
      assert.equal(await run, 0);
    }
  } finally {
    takeoverSeam.beforeRemove = null;
    writeFileSync(stop, '');
  }
  const done = await watcher;
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, '0', 'the lock path was empty while a live holder had it');
  assert.deepEqual(
    readdirSync(dir).filter((name) => !['live', 'stop'].includes(name)),
    [],
    'no guard or moved-aside lock left',
  );
});

test('a fresh lock with no pid is never removed, even when a waiter judged an old one with no pid stale', async () => {
  const lock = path.join(tmp('heavy-lock'), 'lock');
  mkdirSync(lock);
  ageOf(lock, 120);
  // after the waiter judged the old lock stale, another holder made a fresh one and has not written its pid yet
  takeoverSeam.beforeRemove = () => {
    takeoverSeam.beforeRemove = null;
    ageOf(lock, 0);
  };
  try {
    let finished = false;
    const run = runHeavy('waiter', ['true'], () => {}, lockEnv(lock)).then((code) => {
      finished = true;
      return code;
    });
    await pause(400);
    assert.equal(existsSync(lock), true, 'the fresh lock was removed');
    assert.equal(finished, false);
    writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`); // it writes its pid, runs, lets go
    rmSync(lock, { recursive: true });
    assert.equal(await run, 0);
  } finally {
    takeoverSeam.beforeRemove = null;
  }
});

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

test('waiters that judge the same stale lock at once never run together or fail writing their pid', async () => {
  for (let trial = 0; trial < 8; trial++) {
    const dir = tmp('heavy-lock');
    const lock = path.join(dir, 'lock');
    mkdirSync(lock);
    if (trial % 2) {
      writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
    } else {
      ageOf(lock, 120); // a holder that died before writing its pid
    }
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

test('a lock being reaped by another waiter is waited for, and a guard left by a crashed reaper is removed', async () => {
  const dir = tmp('heavy-lock');
  const lock = path.join(dir, 'lock');
  const guard = `${lock}.reap`;
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${deadPid()}\n`);
  mkdirSync(guard);
  let finished = false;
  const run = runHeavy('waiter', ['true'], () => {}, lockEnv(lock)).then((code) => {
    finished = true;
    return code;
  });
  await pause(400);
  assert.equal(finished, false, 'another waiter is reaping: wait');
  assert.equal(existsSync(guard), true);
  assert.ok(statSync(lock).isDirectory());
  ageOf(guard, 30); // its reaper crashed
  assert.equal(await run, 0);
  assert.deepEqual(readdirSync(dir), [], 'the lock and the guard are gone');
});
