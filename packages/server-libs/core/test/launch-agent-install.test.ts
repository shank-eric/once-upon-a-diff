import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import type { Runner } from '@once-upon-a-diff/adapters/os';
import { installLaunchAgent, uninstallLaunchAgent } from '../src/features/launch-agent/install.ts';
import { readLaunchAgentFacts } from '../src/features/launch-agent/status.ts';

/** A repo shaped like the checkout (a bridge folder with its entry), its worktree, and a runner that records what launchctl was asked. */
function fixture() {
  const repoFixture = worktreeFixture('once-upon-a-diff');
  const entryIn = (dir: string) => {
    const bin = path.join(dir, 'packages/server/bridge/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'once-upon.mjs'), '');
    return path.join(bin, 'once-upon.mjs');
  };
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  return {
    ...repoFixture,
    entryIn,
    calls,
    run,
    agentsDir: path.join(tmp('agents'), 'LaunchAgents'),
    home: tmp('home'),
  };
}

const NODE24 = process.execPath;

test('install writes the plist 0644 and boots out, then bootstraps it, in that order', async () => {
  const world = fixture();
  const entry = world.entryIn(world.main);
  const lines = await installLaunchAgent({
    home: world.home,
    entry,
    agentsDir: world.agentsDir,
    uid: 501,
    run: world.run,
    execPath: NODE24,
    nodeVersion: '24.14.0',
    port: 1,
    installPath: '/usr/bin',
  });
  const file = path.join(world.agentsDir, 'dev.onceupon.bridge.plist');
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(world.calls, [
    'launchctl bootout gui/501/dev.onceupon.bridge',
    `launchctl bootstrap gui/501 ${file}`,
  ]);
  assert.match(
    readFileSync(file, 'utf8'),
    new RegExp(`<string>${path.join(world.main, 'packages/server/bridge')}</string>`),
  );
  assert.match(lines[0], /starts at login/);
});

test('install from an agent worktree still points the plist at the main checkout', async () => {
  const world = fixture();
  world.entryIn(world.main);
  const entry = world.entryIn(world.add('feature/x'));
  await installLaunchAgent({
    home: world.home,
    entry,
    agentsDir: world.agentsDir,
    uid: 501,
    run: world.run,
    execPath: NODE24,
    nodeVersion: '24.14.0',
    port: 1,
    installPath: '/usr/bin',
  });
  const text = readFileSync(path.join(world.agentsDir, 'dev.onceupon.bridge.plist'), 'utf8');
  assert.ok(text.includes(`<string>${path.join(world.main, 'packages/server/bridge')}</string>`));
  assert.ok(!text.includes('once-upon-a-diff-worktrees'));
});

test('installing again rewrites the one file and reloads it', async () => {
  const world = fixture();
  const entry = world.entryIn(world.main);
  const options = {
    home: world.home,
    entry,
    agentsDir: world.agentsDir,
    uid: 501,
    run: world.run,
    execPath: NODE24,
    nodeVersion: '24.14.0',
    port: 1,
    installPath: '/usr/bin',
  };
  await installLaunchAgent(options);
  await installLaunchAgent(options);
  assert.equal(world.calls.length, 4);
  assert.equal(existsSync(path.join(world.agentsDir, 'dev.onceupon.bridge.plist')), true);
});

test('Node 23 is refused before anything is written', async () => {
  const world = fixture();
  const entry = world.entryIn(world.main);
  await assert.rejects(
    installLaunchAgent({
      home: world.home,
      entry,
      agentsDir: world.agentsDir,
      run: world.run,
      nodeVersion: '23.9.0',
    }),
    /Node 24 or newer/,
  );
  assert.equal(existsSync(world.agentsDir), false);
  assert.deepEqual(world.calls, []);
});

test('a launchctl that will not load the file is an error, not a quiet success', async () => {
  const world = fixture();
  const entry = world.entryIn(world.main);
  const run: Runner = async (_cmd, args) => ({
    code: args[0] === 'bootstrap' ? 5 : 0,
    stdout: '',
    stderr: 'Bootstrap failed: 5',
    timedOut: false,
  });
  await assert.rejects(
    installLaunchAgent({
      home: world.home,
      entry,
      agentsDir: world.agentsDir,
      uid: 501,
      run,
      execPath: NODE24,
      nodeVersion: '24.14.0',
      port: 1,
    }),
    /Bootstrap failed/,
  );
});

test('uninstall boots the job out and removes the file; absent is not an error', async () => {
  const world = fixture();
  const entry = world.entryIn(world.main);
  await installLaunchAgent({
    home: world.home,
    entry,
    agentsDir: world.agentsDir,
    uid: 501,
    run: world.run,
    execPath: NODE24,
    nodeVersion: '24.14.0',
    port: 1,
  });
  world.calls.length = 0;
  const lines = await uninstallLaunchAgent({
    agentsDir: world.agentsDir,
    uid: 501,
    run: world.run,
  });
  assert.deepEqual(world.calls, [
    'launchctl print gui/501/dev.onceupon.bridge',
    'launchctl bootout gui/501/dev.onceupon.bridge',
  ]);
  assert.doesNotMatch(lines.join('\n'), /stopped with it/);
  assert.match(lines.join('\n'), /started by hand keeps running/);
  assert.equal(existsSync(path.join(world.agentsDir, 'dev.onceupon.bridge.plist')), false);
  await uninstallLaunchAgent({ agentsDir: world.agentsDir, uid: 501, run: world.run });
});

test('uninstall says the bridge stopped when launchd was running it', async () => {
  const world = fixture();
  const running: Runner = async (_cmd, args) => ({
    code: 0,
    stdout: args[0] === 'print' ? 'state = running\n\tpid = 4242\n' : '',
    stderr: '',
    timedOut: false,
  });
  const lines = await uninstallLaunchAgent({ agentsDir: world.agentsDir, uid: 501, run: running });
  assert.match(lines.join('\n'), /pid 4242\) stopped with it/);
  assert.doesNotMatch(lines.join('\n'), /keeps running/);
});

test('the facts say launchd is not there when launchctl is not (no output), and not loaded when it does not know the job', async () => {
  const agentsDir = tmp('agents');
  const missing: Runner = async () => ({ code: 1, stdout: '', stderr: '', timedOut: false });
  assert.equal((await readLaunchAgentFacts(agentsDir, 501, missing)).available, false);
  const unknown: Runner = async () => ({
    code: 113,
    stdout: '',
    stderr: 'Could not find service',
    timedOut: false,
  });
  const facts = await readLaunchAgentFacts(agentsDir, 501, unknown);
  assert.deepEqual([facts.available, facts.loaded, facts.fileExists], [true, false, false]);
  const loaded: Runner = async () => ({
    code: 0,
    stdout: 'state = running\n\tpid = 4242\n',
    stderr: '',
    timedOut: false,
  });
  const running = await readLaunchAgentFacts(agentsDir, 501, loaded);
  assert.deepEqual([running.loaded, running.pid], [true, 4242]);
});
