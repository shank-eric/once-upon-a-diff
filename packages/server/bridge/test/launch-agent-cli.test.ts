import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp } from './helpers.ts';

// `once-upon install-launch-agent` in a temp HOME, with a fake launchctl first on PATH: it writes into the temp
// ~/Library/LaunchAgents and never reaches the real launchd.

function setup() {
  const home = tmp('la-cli-home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const log = path.join(home, 'launchctl.log');
  writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$*" >> '${log}'\n`);
  chmodSync(path.join(bin, 'launchctl'), 0o755);
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const plist = path.join(home, 'Library/LaunchAgents/dev.onceupon.bridge.plist');
  return { home, env, log, plist };
}

test('install-launch-agent writes the plist into HOME and loads it; --uninstall takes both away', async () => {
  const setupResult = setup();
  const done = await runCli(
    path.join(setupResult.home, 'once-upon'),
    ['install-launch-agent'],
    setupResult.env,
  );
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /starts at login/);
  assert.equal(existsSync(setupResult.plist), true);
  const text = readFileSync(setupResult.plist, 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key>/);
  assert.doesNotMatch(text, /KeepAlive/);
  assert.match(text, /packages\/server\/bridge<\/string>/);
  const uid = process.getuid!();
  assert.deepEqual(readFileSync(setupResult.log, 'utf8').trim().split('\n'), [
    `bootout gui/${uid}/dev.onceupon.bridge`,
    `bootstrap gui/${uid} ${setupResult.plist}`,
  ]);
  const gone = await runCli(
    path.join(setupResult.home, 'once-upon'),
    ['install-launch-agent', '--uninstall'],
    setupResult.env,
  );
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(existsSync(setupResult.plist), false);
});
