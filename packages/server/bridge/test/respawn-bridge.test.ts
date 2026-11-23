import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.ts';
import { git, worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { LAUNCH_LABEL } from '@once-upon-a-diff/adapters/launch-agent';

// scripts/lib/respawn-bridge.sh is what scripts/deploy-local.sh restarts the bridge with. This runs the real function against a
// throwaway "main" checkout whose bridge is a stub (listens on $STUB_PORT and answers 200), a random port, and a fake launchctl
// first on PATH, so it never touches the live bridge on 4823 or the real LaunchAgents folder (HOME is a temp folder).

const LIB = fileURLToPath(new URL('../../../../scripts/lib/respawn-bridge.sh', import.meta.url));
const STUB = `import http from 'node:http';
if (process.argv[2] !== 'serve') process.exit(1);
http.createServer((_q, r) => r.end('ok')).listen(Number(process.env.STUB_PORT), '127.0.0.1');
// a stub nobody stopped (a killed or timed-out run never reaches the after hook) ends itself
setTimeout(() => process.exit(0), 120_000);
`;

const kids = new Set<number>();
const bases: string[] = [];

/** a folder is its own or a child of dir, never a sibling that only shares dir's prefix */
const isInside = (folder: string, dir: string) =>
  folder === dir || folder.startsWith(dir + path.sep);

/** pids of every process whose working folder is inside one of the fixtures: the stubs respawn_bridge or the fake launchctl started */
function pidsRunningIn(folders: string[]): number[] {
  let listing = '';
  try {
    listing = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const found: number[] = [];
  let pid = 0;
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && folders.some((dir) => isInside(line.slice(1), dir))) {
      found.push(pid);
    }
  }
  return found;
}

after(() => {
  for (const pid of [...kids, ...pidsRunningIn(bases)]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** A fake main with a stub bridge, a worktree of it, a temp HOME, a log of launchctl's calls and a port. */
async function makeWorld() {
  const repoFixture = worktreeFixture('once-upon-a-diff');
  bases.push(repoFixture.base);
  const stub = path.join(repoFixture.main, 'packages/server/bridge/bin/once-upon.mjs');
  mkdirSync(path.dirname(stub), { recursive: true });
  writeFileSync(stub, STUB);
  const bridge = path.join(repoFixture.main, 'packages/server/bridge');
  const home = tmp('respawn-home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const log = path.join(home, 'launchctl.log');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_PORT: String(port),
    MAIN: repoFixture.main,
    PORT: String(port),
    BRIDGE_LOG: path.join(home, 'bridge.log'),
  };
  /** starts the stub bridge by hand in `cwd`, returning its pid once it answers */
  const startStub = async (cwd: string): Promise<number> => {
    // started from a shell that exits, so launchd (init) adopts it: a child of this test would stay a zombie after its kill, and
    // the blocking shell calls below never let this process reap it
    const started = execFileSync(
      'bash',
      [
        '-c',
        `cd '${cwd}' || exit 1; '${process.execPath}' '${stub}' serve </dev/null >/dev/null 2>&1 & echo $!`,
      ],
      { env, encoding: 'utf8' },
    );
    const pid = Number(started.trim());
    kids.add(pid);
    for (let i = 0; i < 100; i++) {
      if (await answers(port)) {
        return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('stub did not come up');
  };
  const runBash = (script: string) => {
    try {
      const stdout = execFileSync('bash', ['-c', script], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
    }
  };
  /** the real respawn_bridge, with die/say as deploy-local.sh has them; prints the new pid */
  const respawn = () =>
    runBash(
      `set -euo pipefail; die() { echo "deploy-local: $*" >&2; exit 1; }; say() { echo "say: $*"; }; . '${LIB}'; respawn_bridge; echo "PID=$BRIDGE_PID"`,
    );
  const pidOf = (out: string) => {
    const pid = Number(/PID=(\d+)/.exec(out)?.[1]);
    if (pid) {
      kids.add(pid);
    }
    return pid;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /**
   * A launchctl on PATH. `print` answers with the pid in $LAUNCHD_PID_FILE when there is one (as launchd does for a loaded job);
   * `kickstart -k` stops that pid and starts the stub from the bridge folder, as launchd does. Every call is logged.
   */
  const fakeLaunchctl = (opts: {
    loaded: boolean;
    pidFile?: string;
    kickstartDoesNothing?: boolean;
  }) => {
    const file = path.join(bin, 'launchctl');
    writeFileSync(
      file,
      `#!/bin/bash
echo "$*" >> '${log}'
case "$1" in
  print)
    [ '${opts.loaded}' = true ] || exit 113
    echo "gui/501/${LAUNCH_LABEL} = {"
    ${opts.pidFile ? `[ -s '${opts.pidFile}' ] && echo "	pid = $(cat '${opts.pidFile}')"` : ''}
    echo "}"
    ;;
  kickstart)
    ${opts.kickstartDoesNothing ? 'exit 0' : ''}
    ${opts.pidFile ? `[ -s '${opts.pidFile}' ] && kill "$(cat '${opts.pidFile}')" 2>/dev/null; sleep 0.3` : ''}
    cd '${bridge}' || exit 1
    nohup '${process.execPath}' bin/once-upon.mjs serve </dev/null >/dev/null 2>&1 &
    ${opts.pidFile ? `echo $! > '${opts.pidFile}'` : ''}
    ;;
esac
`,
    );
    chmodSync(file, 0o755);
  };
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  /** installs the LaunchAgent's file, as `install-launch-agent` does */
  const plist = () => {
    const dir = path.join(home, 'Library/LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${LAUNCH_LABEL}.plist`), '<plist/>');
  };
  const cwdOf = (pid: number) =>
    execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split('\n')
      .find((line) => line.startsWith('n'))!
      .slice(1);
  return {
    ...repoFixture,
    bridge,
    home,
    port,
    env,
    startStub,
    respawn,
    pidOf,
    alive,
    fakeLaunchctl,
    calls,
    plist,
    cwdOf,
    runBash,
  };
}

async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

test('a bridge started by hand from the repo root is respawned, not refused', async () => {
  const world = await makeWorld();
  const old = await world.startStub(world.main);
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  const fresh = world.pidOf(result.stdout);
  assert.notEqual(fresh, old);
  assert.equal(world.alive(old), false);
  assert.equal(world.cwdOf(fresh), world.bridge);
  assert.deepEqual(world.calls(), [], 'no LaunchAgent: launchctl is never called');
});

test("a bridge started from main's bridge folder is respawned too", async () => {
  const world = await makeWorld();
  const old = await world.startStub(world.bridge);
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.alive(old), false);
  assert.equal(world.cwdOf(world.pidOf(result.stdout)), world.bridge);
});

test('a bridge started from a linked worktree is refused, and left running', async () => {
  const world = await makeWorld();
  const tree = world.add('feature/x');
  const old = await world.startStub(tree);
  const result = world.respawn();
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /runs from .*once-upon-a-diff-worktrees.*feature-x.*not the main checkout/,
  );
  assert.equal(world.alive(old), true);
});

test('a folder inside main that is a nested worktree is refused', async () => {
  const world = await makeWorld();
  const nested = path.join(world.main, 'nested-tree');
  git(world.main, 'worktree', 'add', '-q', nested, '-b', 'nested');
  const old = await world.startStub(nested);
  const result = world.respawn();
  assert.notEqual(result.code, 0);
  assert.equal(world.alive(old), true);
});

test('a process on the port that is not the bridge is refused', async () => {
  const world = await makeWorld();
  const server = net.createServer().listen(world.port, '127.0.0.1');
  after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const result = world.respawn();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /is not the bridge/);
});

test('with the LaunchAgent installed, the bridge launchd runs is restarted by kickstart -k, not by a signal of ours', async () => {
  const world = await makeWorld();
  world.plist();
  const pidFile = path.join(world.home, 'launchd.pid');
  // the "launchd" bridge runs from the repo root: the cwd check is moot on this path
  const old = await world.startStub(world.main);
  writeFileSync(pidFile, String(old));
  world.fakeLaunchctl({ loaded: true, pidFile });
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  const kicks = world.calls().filter((call) => call.startsWith('kickstart'));
  assert.deepEqual(kicks, [`kickstart -k gui/${process.getuid!()}/${LAUNCH_LABEL}`]);
  assert.doesNotMatch(result.stdout, /killing bridge pid/);
  const fresh = world.pidOf(result.stdout);
  assert.notEqual(fresh, old);
  assert.equal(world.alive(old), false);
  assert.equal(world.cwdOf(fresh), world.bridge);
});

test('with the LaunchAgent installed and a bridge started by hand, the hand one is stopped by pid, then kickstarted', async () => {
  const world = await makeWorld();
  world.plist();
  const pidFile = path.join(world.home, 'launchd.pid');
  world.fakeLaunchctl({ loaded: true, pidFile }); // no pid in the file: launchd runs nothing
  const hand = await world.startStub(world.main);
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /killing bridge pid/);
  assert.equal(world.alive(hand), false);
  assert.equal(world.calls().filter((call) => call.startsWith('kickstart -k')).length, 1);
  assert.equal(world.cwdOf(world.pidOf(result.stdout)), world.bridge);
});

test('with the LaunchAgent installed and a worktree bridge by hand, nothing is stopped or kickstarted', async () => {
  const world = await makeWorld();
  world.plist();
  world.fakeLaunchctl({ loaded: true });
  const old = await world.startStub(world.add('feature/y'));
  const result = world.respawn();
  assert.notEqual(result.code, 0);
  assert.equal(world.alive(old), true);
  assert.equal(world.calls().filter((call) => call.startsWith('kickstart')).length, 0);
});

test('when kickstart leaves nothing listening, the plain nohup start takes over and the bridge is up', async () => {
  const world = await makeWorld();
  world.plist();
  world.fakeLaunchctl({ loaded: true, kickstartDoesNothing: true });
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.calls().filter((call) => call.startsWith('kickstart -k')).length, 1);
  assert.match(result.stdout, /launchd did not bring the bridge up.*starting it by hand/);
  assert.match(result.stdout, /install-launch-agent/);
  assert.equal(world.cwdOf(world.pidOf(result.stdout)), world.bridge);
  assert.equal(await answers(world.port), true);
});

test('a plist that launchd has not loaded counts as not installed: the nohup path, no kickstart', async () => {
  const world = await makeWorld();
  world.plist();
  world.fakeLaunchctl({ loaded: false });
  const old = await world.startStub(world.bridge);
  const result = world.respawn();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.alive(old), false);
  assert.equal(world.calls().filter((call) => call.startsWith('kickstart')).length, 0);
});

test('the shell script and the adapter name the same launchd label', () => {
  const lib = readFileSync(LIB, 'utf8');
  assert.match(lib, new RegExp(`^LAUNCH_LABEL=${LAUNCH_LABEL.replace(/\./g, '\\.')}$`, 'm'));
});
