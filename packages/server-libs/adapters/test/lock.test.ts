import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { takeoverSeam, updateJson, waitSeam, withLock } from '../src/stores/fs/lock.ts';

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

/** A process that stays alive until the test kills it. */
function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

test('a takeover goes one reaper at a time: while one holds the guard, another process neither reaps nor runs', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(lock, JSON.stringify({ pid: Number(gone.stdout), at: new Date().toISOString() }));
  const script = path.join(tmp('lock-script'), 'second-reaper.ts');
  writeFileSync(
    script,
    `import { waitSeam, withLock } from ${LOCK_MODULE};
waitSeam.limitMs = 500;
try { process.stdout.write(withLock(process.argv[2], () => 'ran')); } catch { process.stdout.write('blocked'); }
`,
  );
  let second = '';
  // this reaper has the guard and has judged the dead holder's lock; a second process wants the lock meanwhile
  takeoverSeam.beforeRemove = () => {
    takeoverSeam.beforeRemove = null;
    second = spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      timeout: 30_000,
    }).stdout;
  };
  try {
    assert.equal(
      withLock(file, () => 'ran'),
      'ran',
    );
  } finally {
    takeoverSeam.beforeRemove = null;
  }
  assert.equal(second, 'blocked', 'the dead holder’s lock is not reaped by two at once');
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

test('a lock naming this process that it does not hold is stale: an earlier process had this pid', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  writeFileSync(
    `${file}.lock`,
    JSON.stringify({ pid: process.pid, token: 'earlier', at: new Date().toISOString() }),
  );
  const started = Date.now();
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
  assert.ok(Date.now() - started < 1000);
  assert.ok(!existsSync(`${file}.lock`));
});

test('a lock whose live pid started after the lock was made is stale: the pid was reused', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const other = sleeper();
  try {
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: other.pid, token: 'crashed', at: '2020-01-01T00:00:00.000Z' }),
    );
    assert.equal(
      withLock(file, () => 'ran'),
      'ran',
    );
    assert.ok(!existsSync(`${file}.lock`));
  } finally {
    other.kill('SIGKILL');
  }
});

test('a wait for a live holder past the limit throws, naming the lock, and leaves the lock alone', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  const holder = sleeper();
  const text = JSON.stringify({ pid: holder.pid, token: 'live', at: new Date().toISOString() });
  writeFileSync(lock, text);
  const before = waitSeam.limitMs;
  waitSeam.limitMs = 300;
  try {
    const started = Date.now();
    assert.throws(
      () => withLock(file, () => 'ran'),
      (err: Error) =>
        err.message.includes(lock) &&
        err.message.includes(`pid ${holder.pid}`) &&
        err.message.includes('remove the file'),
    );
    assert.ok(Date.now() - started >= 300, 'it waited out the limit first');
    assert.equal(readFileSync(lock, 'utf8'), text, 'the live holder keeps its lock');
  } finally {
    waitSeam.limitMs = before;
    holder.kill('SIGKILL');
  }
});

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

test('a lock held by a live pid is never taken over, however old', async () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const waiter = contender(file);
  try {
    await settle(1500);
    assert.ok(!existsSync(`${file}.ran`), 'the waiter is still waiting');
    assert.equal(waiter.exitCode, null);
    rmSync(lock); // the holder lets go
    await new Promise((resolve) => waiter.on('close', resolve));
    assert.ok(existsSync(`${file}.ran`), 'and runs once the holder let go');
  } finally {
    waiter.kill('SIGKILL');
  }
});

test('a lock with no readable pid, older than the stale age, is taken over; a fresh one is waited for', async () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, '{"pid":');
  const waiter = contender(file);
  try {
    await settle(1500);
    assert.ok(!existsSync(`${file}.ran`), 'a half-written lock that is new is waited for');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await new Promise((resolve) => waiter.on('close', resolve));
    assert.ok(existsSync(`${file}.ran`), 'and taken over once it is old');
  } finally {
    waiter.kill('SIGKILL');
  }
});

test('a holder whose lock another made since lets go of nothing', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const lock = `${file}.lock`;
  const theirs = JSON.stringify({
    pid: process.ppid,
    token: 'theirs',
    at: new Date().toISOString(),
  });
  withLock(file, () => {
    rmSync(lock); // taken over (a crash judged it so) and made fresh by another holder
    writeFileSync(lock, theirs);
  });
  assert.equal(readFileSync(lock, 'utf8'), theirs, 'the other holder keeps its lock');
  // the same pid with another acquire's token is not ours either
  rmSync(lock);
  const sameProcess = JSON.stringify({ pid: process.pid, token: 'other', at: 'x' });
  withLock(file, () => writeFileSync(lock, sameProcess));
  assert.equal(readFileSync(lock, 'utf8'), sameProcess);
});

test('a takeover guard left by a crashed reaper is cleared once it is old', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: Number(gone.stdout), at: 'x' }));
  writeFileSync(`${file}.lock.reap`, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock.reap`, old, old);
  assert.equal(
    withLock(file, () => 'ran'),
    'ran',
  );
  assert.ok(!existsSync(`${file}.lock`) && !existsSync(`${file}.lock.reap`));
});

test('a stale guard is removed only if it is still the one judged: a fresh guard made since stays', () => {
  const file = path.join(tmp('lock'), 'builds.json');
  const guard = `${file}.lock.reap`;
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: Number(gone.stdout), at: 'x' }));
  writeFileSync(guard, 'old');
  const old = new Date(Date.now() - 60_000);
  utimesSync(guard, old, old);
  // the old guard is judged, then another waiter removes it and a live reaper makes a fresh one
  takeoverSeam.beforeGuardRemove = () => {
    takeoverSeam.beforeGuardRemove = null;
    rmSync(guard);
    writeFileSync(guard, 'fresh');
  };
  const before = waitSeam.limitMs;
  waitSeam.limitMs = 300;
  try {
    assert.throws(() => withLock(file, () => 'ran'), /remove the file/);
    assert.equal(readFileSync(guard, 'utf8'), 'fresh', 'the live reaper keeps its guard');
    assert.ok(existsSync(`${file}.lock`), 'and no one reaped under it');
  } finally {
    takeoverSeam.beforeGuardRemove = null;
    waitSeam.limitMs = before;
  }
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
