import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, runCli } from './helpers.ts';
import { assertPrivate } from './usage-helpers.ts';
import type { CoverageFile } from '@once-upon-a-diff/usage/merge';

const BIN = path.resolve(import.meta.dirname, '../bin/once-upon.mjs');
const TOKEN = 'usage-process-token-0123456789';

/** A real `once-upon serve` in its own temp home on a free port (never 4823), capturing as the live bridge does. */
async function serve(home: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  writeJson(path.join(home, 'config.json'), { port, token: TOKEN });
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    env: { ...process.env, ONCE_UPON_HOME: home, ONCE_UPON_USAGE: 'force' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr!.on('data', (chunk) => (log += chunk));
  const until = Date.now() + 15000;
  while (!log.includes('listening') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(log.includes('listening'), log);
  const call = (method: string, route: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { child, port, call };
}
const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; ms: number }>((resolve) => {
    const start = Date.now();
    child.once('exit', (code) => resolve({ code, ms: Date.now() - start }));
  });
const file = (home: string, name: string) => path.join(home, 'usage', name);
const read = <T>(home: string, name: string) =>
  JSON.parse(readFileSync(file(home, name), 'utf8')) as T;

test('SIGTERM flushes the live bridge and exits at once; a report then reads what it flushed', async () => {
  const home = tmp('home');
  const { child, call } = await serve(home);
  try {
    await call('GET', '/api/health');
    await call('POST', '/api/usage', { counts: { 'board.tab.switch': 2 } });
    // a deploy's SIGTERM: the late counts are kept, the process ends itself within the cap
    const done = exited(child);
    child.kill('SIGTERM');
    const { code, ms } = await done;
    assert.equal(code, 143, 'the handler ends the process itself');
    assert.ok(ms < 2500, `exits within the cap (${ms} ms)`);
    const actions = read<{ days: Record<string, { ui: Record<string, Record<string, number>> }> }>(
      home,
      'actions.json',
    );
    assert.equal(
      Object.values(actions.days)[0].ui.token['board.tab.switch'],
      2,
      'the shutdown flush kept the late count',
    );
    assert.ok(!existsSync(file(home, 'bridge-pid.json')), 'no pid file is written any more');
    const report = await runCli(home, ['usage', 'report', '--json', '--no-save'], {
      ONCE_UPON_USAGE: 'force',
    });
    assert.equal(report.code, 0, report.stderr);
    const data = JSON.parse(report.stdout) as {
      ui: Record<string, number>;
      routes: Record<string, number>;
      sources: { bridge: { starts: number; lastFlush: string | null } };
    };
    assert.equal(data.ui['board.tab.switch'], 2);
    assert.equal(data.routes.health, 1);
    assert.equal(data.sources.bridge.starts, 1);
    assert.ok(data.sources.bridge.lastFlush);
    assert.ok(
      read<CoverageFile>(home, 'coverage-bridge.json').files['packages/server/server/src/index.ts'],
    );
    assertPrivate(home);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a report never signals any process: a live process named in a stale pid file is left alone', async () => {
  const home = tmp('home');
  const node = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    // SIGUSR2 would end this process (nothing handles it): the report must not send it
    writeJson(file(home, 'bridge-pid.json'), {
      pid: node.pid,
      startedAt: new Date().toISOString(),
    });
    const report = await runCli(home, ['usage', 'report', '--no-save'], {
      ONCE_UPON_USAGE: 'force',
    });
    assert.equal(report.code, 0, report.stderr);
    assert.equal(process.kill(node.pid as number, 0), true, 'still alive');
  } finally {
    node.kill();
  }
});

test('a bridge killed by SIGINT also flushes, and a second signal does not wait', async () => {
  const home = tmp('home');
  const { child, call } = await serve(home);
  try {
    await call('GET', '/api/health');
    const done = exited(child);
    child.kill('SIGINT');
    child.kill('SIGINT');
    assert.equal((await done).code, 143);
    assert.ok(read<CoverageFile>(home, 'coverage-bridge.json').starts >= 1);
  } finally {
    child.kill('SIGKILL');
  }
});

test('fix 3: a second `serve` on a busy port records no start', async () => {
  const home = tmp('home');
  const { child, port } = await serve(home);
  try {
    const second = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
      env: { ...process.env, ONCE_UPON_HOME: home, ONCE_UPON_USAGE: 'force' },
      stdio: 'ignore',
    });
    const gone = exited(second);
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      gone,
      new Promise<null>((resolve) => (giveUp = setTimeout(() => resolve(null), 8000))),
    ]);
    clearTimeout(giveUp);
    if (result === null) {
      second.kill('SIGKILL');
    }
    assert.ok(result, 'the second serve gave up on the busy port');
    const done = exited(child);
    child.kill('SIGTERM');
    await done;
    const report = await runCli(home, ['usage', 'report', '--json', '--no-save'], {
      ONCE_UPON_USAGE: 'force',
    });
    const data = JSON.parse(report.stdout) as { sources: { bridge: { starts: number } } };
    assert.equal(data.sources.bridge.starts, 1, 'no phantom start from the loser');
  } finally {
    child.kill('SIGKILL');
  }
});

test('fix 2: `usage clear` while the bridge runs: its old counts stay cleared', async () => {
  const home = tmp('home');
  const { child, call } = await serve(home);
  try {
    await call('POST', '/api/usage', { counts: { 'board.tab.switch': 2 } });
    assert.equal((await runCli(home, ['usage', 'clear'])).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // the bridge looks at the clear once a second
    await call('POST', '/api/usage', { counts: { 'board.idle.toggle': 1 } });
    const done = exited(child);
    child.kill('SIGTERM');
    await done;
    const second = await runCli(home, ['usage', 'report', '--json', '--no-save'], {
      ONCE_UPON_USAGE: 'force',
    });
    const data = JSON.parse(second.stdout) as { ui: Record<string, number> };
    assert.equal(data.ui['board.tab.switch'], undefined, 'the cleared count did not come back');
    assert.equal(data.ui['board.idle.toggle'], 1);
  } finally {
    child.kill('SIGKILL');
  }
});

test("fix 4: processes that read-merge-write coverage-cli.json at once keep each other's lines", () => {
  const home = tmp('home');
  const script = path.join(tmp('lock'), 'writer.ts');
  const store = path.resolve(
    import.meta.dirname,
    '../../../server-libs/usage/src/adapters/usage-file.ts',
  );
  writeFileSync(
    script,
    `import { readUsageJson, writeUsageJson, withUsageLock } from ${JSON.stringify(store)};
const [home, who] = process.argv.slice(2);
for (let n = 0; n < 25; n++) {
  withUsageLock(home, 'coverage-cli.json', () => {
    const file = readUsageJson(home, 'coverage-cli.json') ?? { lines: [] };
    file.lines.push(who + ':' + n);
    writeUsageJson(home, 'coverage-cli.json', file);
  });
}
`,
  );
  mkdirSync(path.join(home, 'usage'), { recursive: true });
  const writers = ['a', 'b', 'c', 'd'].map((who) =>
    spawn(process.execPath, [script, home, who], { stdio: 'inherit' }),
  );
  return Promise.all(
    writers.map((writer) => new Promise((resolve) => writer.once('exit', resolve))),
  ).then(() => {
    const lines = read<{ lines: string[] }>(home, 'coverage-cli.json').lines;
    assert.equal(lines.length, 100, 'every write survived');
    assert.ok(!existsSync(file(home, 'coverage-cli.json.lock')), 'the lock is let go');
  });
});

test('fix 4: a lock a crashed run left behind is taken over, not waited on forever', () => {
  const home = tmp('home');
  const lock = file(home, 'coverage-cli.json.lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  const started = Date.now();
  const store = path.resolve(
    import.meta.dirname,
    '../../../server-libs/usage/src/adapters/usage-file.ts',
  );
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withUsageLock } from ${JSON.stringify(store)}; process.stdout.write(withUsageLock(${JSON.stringify(home)}, 'coverage-cli.json', () => 'ran'))`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(out, 'ran');
  assert.ok(Date.now() - started < 1400, 'no wait for the full timeout');
  assert.ok(!existsSync(lock));
});
