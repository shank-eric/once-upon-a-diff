import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { takeoverSeam, updateJson, withLock } from '../src/stores/fs/lock.ts';

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

test('a lock left by a process that is gone is taken over at once', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(
    `${file}.lock`,
    JSON.stringify({ pid: Number(gone.stdout), at: new Date().toISOString() }),
  );
  const started = Date.now();
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
  assert.ok(Date.now() - started < 1000, 'no wait for the lock to age');
  assert.ok(!existsSync(`${file}.lock`));
});

test('a takeover removes only the lock it judged stale, not a fresh one another process made since', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  const released = `${file}.released`;
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(lock, JSON.stringify({ pid: Number(gone.stdout), at: new Date().toISOString() }));
  // after the dead holder's lock is judged stale, it goes the ordinary way and a live process makes a fresh one,
  // which it lets go 300 ms later
  takeoverSeam.beforeRemove = () => {
    takeoverSeam.beforeRemove = null;
    rmSync(lock);
    const letGo = `const fs = require('node:fs'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(released)}, ''); fs.rmSync(${JSON.stringify(lock)}); }, 300);`;
    const holder = spawn(process.execPath, ['-e', letGo], { stdio: 'ignore' });
    writeFileSync(lock, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
  };
  try {
    assert.ok(
      withLock(file, () => existsSync(released)),
      'the fresh lock was waited for, not removed',
    );
  } finally {
    takeoverSeam.beforeRemove = null;
  }
});

test('a lock older than the stale age is taken over, even when its pid looks alive', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  writeFileSync(
    `${file}.lock`,
    JSON.stringify({ pid: process.ppid, at: '2026-01-01T00:00:00.000Z' }),
  );
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
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
