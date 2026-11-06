/** scripts/heavy.sh from the repo: one lock, taken in turn, never held by a dead process, in a lock folder a test picks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { ROOT, runScript, until } from './script-helpers.ts';

const HEAVY = path.join(ROOT, 'scripts/heavy.sh');

test('it runs the command, passes its exit code and frees the lock', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  const env = { ONCE_UPON_HEAVY_LOCK: lock, ONCE_UPON_HEAVY_POLL: '0.1' };
  const ok = await runScript(HEAVY, ['one', 'echo', 'ran'], env);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), 'ran');
  assert.equal(existsSync(lock), false);
  const failed = await runScript(HEAVY, ['one', 'sh', '-c', 'exit 3'], env);
  assert.equal(failed.code, 3);
  assert.equal(existsSync(lock), false);
});

test('a second run waits for the first and runs after it', async () => {
  const dir = tmp('heavy');
  const lock = path.join(dir, 'lock');
  const order = path.join(dir, 'order.txt');
  const env = { ONCE_UPON_HEAVY_LOCK: lock, ONCE_UPON_HEAVY_POLL: '0.1' };
  const first = runScript(
    HEAVY,
    ['first', 'sh', '-c', `echo first-start >> ${order}; sleep 1; echo first-end >> ${order}`],
    env,
  );
  assert.ok(await until(() => existsSync(order)), 'the first run holds the lock');
  assert.match(readFileSync(path.join(lock, 'who'), 'utf8'), /^first \(.*\): sh -c/);
  const second = await runScript(HEAVY, ['second', 'sh', '-c', `echo second >> ${order}`], env);
  await first;
  assert.match(second.stderr, /waiting for first/);
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), [
    'first-start',
    'first-end',
    'second',
  ]);
});

test('a lock held by a pid that is gone is taken over', async () => {
  const lock = path.join(tmp('heavy'), 'lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), '999999999');
  const run = await runScript(HEAVY, ['x', 'echo', 'ran'], {
    ONCE_UPON_HEAVY_LOCK: lock,
    ONCE_UPON_HEAVY_POLL: '0.1',
  });
  assert.equal(run.stdout.trim(), 'ran');
  assert.equal(run.stderr, '');
});

test('with no override the lock is ~/.cache/heavy-run.lock, or under XDG_CACHE_HOME', async () => {
  const home = tmp('heavy-home');
  const base = { HOME: home, ONCE_UPON_HEAVY_LOCK: null, XDG_CACHE_HOME: null };
  const seen = await runScript(
    HEAVY,
    ['x', 'sh', '-c', 'cat "$HOME/.cache/heavy-run.lock/who"'],
    base,
  );
  assert.match(seen.stdout, /^x \(/);
  const xdg = tmp('heavy-xdg');
  const viaXdg = await runScript(HEAVY, ['y', 'sh', '-c', `cat "${xdg}/heavy-run.lock/who"`], {
    ...base,
    XDG_CACHE_HOME: xdg,
  });
  assert.match(viaXdg.stdout, /^y \(/);
});
