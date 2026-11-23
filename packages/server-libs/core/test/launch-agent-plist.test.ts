import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import '@once-upon-a-diff/test-kit/env';
import { launchAgentPlist, launchPath } from '../src/features/launch-agent/plist.ts';

const hasPlutil = (() => {
  try {
    execFileSync('plutil', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** What `plutil` makes of the text: it is the parser launchd's own tools use. */
const parsed = (xml: string) =>
  JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }),
  );

const NODE = '/Users/x/.local/share/fnm/node-versions/v24.14.0/installation/bin/node';
const BRIDGE = '/Users/x/Development/once-upon-a-diff/packages/server/bridge';
const input = {
  label: 'dev.onceupon.bridge',
  node: NODE,
  bridgeDir: BRIDGE,
  logFile: '/Users/x/.once-upon/bridge.log',
  path: '/a:/b',
};

test(
  "the plist runs main's bridge folder on the Node 24 serve command, at login, with no KeepAlive",
  { skip: !hasPlutil },
  () => {
    const plist = parsed(launchAgentPlist(input));
    assert.equal(plist.WorkingDirectory, BRIDGE);
    assert.deepEqual(plist.ProgramArguments, [NODE, `${BRIDGE}/bin/once-upon.mjs`, 'serve']);
    assert.match(plist.ProgramArguments[0], /node-versions\/v24\./);
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.AbandonProcessGroup, true);
    assert.equal('KeepAlive' in plist, false);
    assert.equal(plist.StandardOutPath, '/Users/x/.once-upon/bridge.log');
    assert.equal(plist.StandardErrorPath, '/Users/x/.once-upon/bridge.log');
    assert.deepEqual(plist.EnvironmentVariables, { PATH: '/a:/b' });
  },
);

test('ONCE_UPON_HOME goes into the job only when the install had one', { skip: !hasPlutil }, () => {
  const plist = parsed(launchAgentPlist({ ...input, onceUponHome: '/h/.once-upon' }));
  assert.equal(plist.EnvironmentVariables.ONCE_UPON_HOME, '/h/.once-upon');
});

test('markup characters in a path are escaped', { skip: !hasPlutil }, () => {
  const plist = parsed(launchAgentPlist({ ...input, bridgeDir: '/Users/a&b/<x>/bridge' }));
  assert.equal(plist.WorkingDirectory, '/Users/a&b/<x>/bridge');
});

test('the job PATH has Node first, no fnm multishell link, and the homes of gh, git and claude', () => {
  const dirs = launchPath({
    nodeDir: '/n/bin',
    installPath: '/Users/x/.local/state/fnm_multishells/123_456/bin:/opt/homebrew/bin:/custom/bin:',
    home: '/Users/x',
  }).split(':');
  assert.equal(dirs[0], '/n/bin');
  assert.ok(!dirs.some((dir) => dir.includes('fnm_multishells')));
  assert.ok(dirs.includes('/Users/x/.local/bin'));
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/custom/bin'));
  assert.equal(new Set(dirs).size, dirs.length, 'no folder twice');
  assert.ok(dirs.every(Boolean));
});
