import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { doctor } from '../src/orchestration/bridge/doctor.ts';
import type { LaunchAgentFacts } from '../src/features/launch-agent/status.ts';

/** The doctor's line for the LaunchAgent, given what launchd and the file are said to be. */
async function lineFor(facts: Partial<LaunchAgentFacts>, port = 1): Promise<string[]> {
  const out: string[] = [];
  await doctor(
    tmp('doctor-home'),
    { token: 't', port },
    {
      out: (text) => out.push(text),
      launchAgent: async () => ({
        available: true,
        file: '/L/dev.onceupon.bridge.plist',
        fileExists: true,
        loaded: true,
        pid: 77,
        workingDirectory: null,
        program: null,
        uid: 501,
        ...facts,
      }),
    },
  );
  const found = out.findIndex((text) => text.includes('Bridge at login:'));
  return found < 0
    ? []
    : out.slice(found, out[found + 1]?.includes('fix:') ? found + 2 : found + 1);
}

test('no LaunchAgent is a WARN with the install command as the fix', async () => {
  const [line, fix] = await lineFor({ fileExists: false, loaded: false, pid: null });
  assert.match(line, /^WARN/);
  assert.match(fix, /once-upon install-launch-agent/);
});

test('a file launchd has not loaded is a WARN naming bootstrap', async () => {
  const [line, fix] = await lineFor({ loaded: false, pid: null });
  assert.match(line, /^WARN .*not loaded it/);
  assert.match(fix, /launchctl bootstrap gui\/501 \/L\/dev\.onceupon\.bridge\.plist/);
});

test('a loaded job whose program or folder is gone is a WARN to install again', async () => {
  const dir = tmp('la-dir');
  const gone = path.join(dir, 'moved/bin/once-upon.mjs');
  const [line, fix] = await lineFor({ program: gone, workingDirectory: dir });
  assert.match(line, /^WARN .*once-upon\.mjs, which is not there/);
  assert.match(fix, /install-launch-agent/);
});

test('a loaded job whose files are there passes', async () => {
  const dir = tmp('la-ok');
  mkdirSync(path.join(dir, 'bin'));
  const program = path.join(dir, 'bin/once-upon.mjs');
  writeFileSync(program, '');
  const [line] = await lineFor({ program, workingDirectory: dir });
  assert.match(line, /^PASS .*starts at login.*pid 77/);
});

test('a loaded job that is not running, with nothing on the port, is a WARN with a kickstart fix', async () => {
  const dir = tmp('la-idle');
  mkdirSync(path.join(dir, 'bin'));
  const program = path.join(dir, 'bin/once-upon.mjs');
  writeFileSync(program, '');
  const [line, fix] = await lineFor({ program, workingDirectory: dir, pid: null });
  assert.match(line, /^WARN .*loaded but it is not running/);
  assert.match(fix, /launchctl kickstart -k gui\/501\//);
});

test('a loaded job with no pid and a bridge on the port is the INFO for a bridge started by hand, not a PASS', async () => {
  const dir = tmp('la-hand');
  mkdirSync(path.join(dir, 'bin'));
  const program = path.join(dir, 'bin/once-upon.mjs');
  writeFileSync(program, '');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as net.AddressInfo;
    const [line] = await lineFor({ program, workingDirectory: dir, pid: null }, port);
    assert.match(line, /^INFO .*started by hand/);
  } finally {
    server.close();
  }
});

test('without launchctl (not a Mac) the doctor says nothing about it', async () => {
  assert.deepEqual(await lineFor({ available: false }), []);
});
