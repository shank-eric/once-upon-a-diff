import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import lockfile from 'proper-lockfile';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { updateJson, waitSeam, withLock } from '../src/stores/fs/lock.ts';
import { removeLeftover } from '../src/stores/fs/folder-lock.ts';

const LOCK_MODULE = JSON.stringify(path.resolve(import.meta.dirname, '../src/stores/fs/lock.ts'));

test('processes that update one file at once under its lock keep every change, and let the lock go', async () => {
  const file = path.join(tmp('lock'), 'count.json');
  const script = path.join(tmp('lock-script'), 'counter.ts');
  writeFileSync(
    script,
    `import { updateJson } from ${LOCK_MODULE};
for (let n = 0; n < 25; n++) updateJson(process.argv[2], { count: 0 }, (value) => { value.count += 1; });
`,
  );
  const children = [1, 2, 3, 4].map(
    () =>
      new Promise((resolve) =>
        spawn(process.execPath, [script, file], { stdio: 'inherit' }).on('close', resolve),
      ),
  );
  assert.deepEqual(await Promise.all(children), [0, 0, 0, 0]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).count, 100);
  assert.ok(!existsSync(`${file}.lock`));
});

const ageOf = (target: string, seconds: number) => {
  const old = new Date(Date.now() - seconds * 1000);
  utimesSync(target, old, old);
};

/** Runs withLock on `file` in another process, which writes `<file>.ran` once it holds the lock. */
function contender(file: string) {
  const script = path.join(tmp('lock-script'), 'contender.ts');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
import { withLock } from ${LOCK_MODULE};
withLock(process.argv[2], () => writeFileSync(process.argv[2] + '.ran', ''));
`,
  );
  return spawn(process.execPath, [script, file], { stdio: 'inherit' });
}

const settle = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

test('a lock folder nobody has touched for over the stale age is taken over at once: a live holder cannot be told from a dead one', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  mkdirSync(lock);
  ageOf(lock, 60);
  const started = Date.now();
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
  assert.ok(Date.now() - started < 1000, 'no wait');
  assert.ok(!existsSync(lock));
});

test('a lock younger than the stale age is waited for, even one that a holder has not touched for a while', async () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  mkdirSync(lock);
  ageOf(lock, 20);
  const waiter = contender(file);
  try {
    await settle(1500);
    assert.ok(!existsSync(`${file}.ran`), 'the waiter is still waiting');
    assert.equal(waiter.exitCode, null);
    rmdirSync(lock); // the holder lets go
    await new Promise((resolve) => waiter.on('close', resolve));
    assert.ok(existsSync(`${file}.ran`), 'and runs once the holder let go');
  } finally {
    waiter.kill('SIGKILL');
  }
});

test('a wait past the limit throws, naming the lock, and leaves the lock alone', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  mkdirSync(lock);
  const before = waitSeam.limitMs;
  waitSeam.limitMs = 300;
  try {
    const started = Date.now();
    assert.throws(
      () => withLock(file, () => 'ran'),
      (err: Error) => err.message.includes(lock) && err.message.includes('remove the folder'),
    );
    assert.ok(Date.now() - started >= 300, 'it waited out the limit first');
    assert.ok(existsSync(lock), 'the holder keeps its lock');
  } finally {
    waitSeam.limitMs = before;
  }
});

test('a holder whose lock was taken from it finishes normally: its release failing does not turn finished work into an error', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const result = withLock(file, () => {
    // the package no longer counts the lock as ours (what a takeover leaves in this process): its release throws
    lockfile.unlockSync(file, { realpath: false });
    return 'ran';
  });
  assert.equal(result, 'ran', 'its finished work is not turned into an error');
  assert.ok(!existsSync(`${file}.lock`));
});

test(
  'a lock that cannot be made fails at once instead of waiting out the limit',
  {
    skip: process.getuid?.() === 0 ? 'root can write anywhere' : false,
  },
  () => {
    const dir = tmp('lock');
    chmodSync(dir, 0o500);
    try {
      const started = Date.now();
      assert.throws(
        () => withLock(path.join(dir, 'builds.json'), () => 'ran'),
        (err: NodeJS.ErrnoException) => err.code === 'EACCES',
      );
      assert.ok(Date.now() - started < 1000, 'no wait');
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

// `<file>.lock` was a file (made by an earlier version, holding a pid).

test('a lock FILE left by an earlier version is cleared once it is old, whatever its age beyond that', () => {
  for (const seconds of [5, 600]) {
    const file = path.join(tmp('lock'), 'builds.json');
    const lock = `${file}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 99999999, at: new Date().toISOString() }));
    ageOf(lock, seconds);
    const started = Date.now();
    assert.equal(
      withLock(file, () => 'ran'),
      'ran',
    );
    assert.ok(Date.now() - started < 1000, `a ${seconds} s old file: no wait`);
    assert.ok(!existsSync(lock), 'no lock path is left');
  }
});

test('a lock FILE an earlier version made a moment ago is waited for, not removed, and the run goes once it is gone', async () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const waiter = contender(file);
  try {
    await settle(800);
    assert.ok(existsSync(lock), 'the young file is left alone');
    assert.ok(!existsSync(`${file}.ran`), 'and waited for');
    rmSync(lock); // the old holder lets go
    await new Promise((resolve) => waiter.on('close', resolve));
    assert.ok(existsSync(`${file}.ran`));
    assert.ok(!existsSync(lock));
  } finally {
    waiter.kill('SIGKILL');
  }
});

test('a lock FILE that stays young is cleared once it passes two seconds', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, 'x');
  const started = Date.now();
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 1500 && waited < 5000, `waited ${waited} ms`);
  assert.ok(!existsSync(lock));
});

test('a throw lets the lock go and writes nothing; a nested lock on the same file runs at once', () => {
  const file = path.join(tmp('lock'), 'fixes.json');
  writeFileSync(file, '{"a":1}');
  assert.throws(() =>
    updateJson<Record<string, number>, void>(file, {}, (value) => {
      value.a = 2;
      throw new Error('no');
    }),
  );
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  assert.ok(!existsSync(`${file}.lock`));
  const inner = withLock(file, () =>
    updateJson<Record<string, number>, number>(file, {}, (value) => {
      value.b = 3;
      return value.b;
    }),
  );
  assert.equal(inner, 3);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).b, 3);
  assert.ok(!existsSync(`${file}.lock`), 'let go when the outer hold ends');
});

test('removing a leftover goes by kind: a file or link is unlinked, a filled folder emptied and removed, an empty folder (a fresh lock) never', () => {
  const dir = tmp('lock');
  const file = path.join(dir, 'a.lock');
  writeFileSync(file, 'x');
  assert.equal(removeLeftover(file), true);
  assert.ok(!existsSync(file));

  const link = path.join(dir, 'b.lock');
  symlinkSync(path.join(dir, 'nowhere'), link);
  assert.equal(removeLeftover(link), true);

  const filled = path.join(dir, 'c.lock');
  mkdirSync(filled);
  writeFileSync(path.join(filled, 'pid'), '1');
  writeFileSync(path.join(filled, 'who'), 'x');
  assert.equal(removeLeftover(filled), true);
  assert.ok(!existsSync(filled));

  const fresh = path.join(dir, 'd.lock'); // another process's lock, made after the leftover was judged
  mkdirSync(fresh);
  assert.equal(removeLeftover(fresh), false);
  assert.ok(existsSync(fresh), 'an empty lock folder is left alone');
  assert.equal(removeLeftover(path.join(dir, 'gone.lock')), false);
});
