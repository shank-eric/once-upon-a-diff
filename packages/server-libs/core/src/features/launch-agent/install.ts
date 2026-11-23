/*
 * `once-upon install-launch-agent [--uninstall]`: the steps. Install writes the plist for main's bridge folder and loads it;
 * uninstall unloads it and removes the file. The CLI passes plain values (its home and its own script path); this builds the
 * Runner from the adapters. A test passes its own Runner, agents folder and uid, so it never touches launchd.
 */
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_NODE_MAJOR } from '@once-upon-a-diff/foundation/node-version.mjs';
import { worktreeList } from '@once-upon-a-diff/adapters/git';
import { listenerPid, runCommand, type Runner } from '@once-upon-a-diff/adapters/os';
import {
  LAUNCH_LABEL,
  launchAgentFile,
  launchJob,
  loadLaunchAgent,
  removeLaunchAgent,
  unloadLaunchAgent,
  writeLaunchAgent,
} from '@once-upon-a-diff/adapters/launch-agent';
import { launchAgentPlist, launchPath } from './plist.ts';

export interface LaunchAgentOptions {
  /** the bridge's home (~/.once-upon), where its log is */
  home: string;
  /** the CLI's own script (`process.argv[1]`): the checkout it belongs to is found from it */
  entry: string;
  port?: number;
  agentsDir?: string;
  uid?: number;
  run?: Runner;
  /** the Node to run the bridge on, and its version, for tests; this process's by default */
  execPath?: string;
  nodeVersion?: string;
  installPath?: string;
  onceUponHome?: string;
}

export const defaultAgentsDir = (): string => path.join(os.homedir(), 'Library', 'LaunchAgents');

/** The main checkout's bridge folder: the first worktree of the repo the script is in, so an agent's worktree still points at main. */
function mainBridgeDir(entry: string): string {
  const here = path.dirname(path.dirname(realpathSync(entry)));
  const first = worktreeList(here)
    .split('\n')
    .find((line) => line.startsWith('worktree '));
  if (!first) {
    throw new Error(`no git checkout around ${entry}`);
  }
  return path.join(realpathSync(first.slice('worktree '.length)), 'packages/server/bridge');
}

/** The lines to print. Throws a plain message when it cannot install. */
export async function installLaunchAgent(options: LaunchAgentOptions): Promise<string[]> {
  const {
    home,
    entry,
    port = 4823,
    agentsDir = defaultAgentsDir(),
    uid = process.getuid?.() ?? 0,
    run = runCommand,
    execPath = process.execPath,
    nodeVersion = process.versions.node,
    installPath = process.env.PATH ?? '',
    onceUponHome = process.env.ONCE_UPON_HOME,
  } = options;
  if (Number(nodeVersion.split('.')[0]) < MIN_NODE_MAJOR) {
    throw new Error(
      `the LaunchAgent runs the bridge on the Node running this command, and that is v${nodeVersion}: run it on Node ${MIN_NODE_MAJOR} or newer (fnm exec --using=${MIN_NODE_MAJOR} once-upon install-launch-agent)`,
    );
  }
  const bridgeDir = mainBridgeDir(entry);
  if (!existsSync(path.join(bridgeDir, 'bin/once-upon.mjs'))) {
    throw new Error(
      `no bridge at ${bridgeDir}/bin/once-upon.mjs: run this from the once-upon checkout`,
    );
  }
  const node = realpathSync(execPath);
  const file = launchAgentFile(agentsDir);
  writeLaunchAgent(
    file,
    launchAgentPlist({
      label: LAUNCH_LABEL,
      node,
      bridgeDir,
      logFile: path.join(home, 'bridge.log'),
      path: launchPath({
        nodeDir: path.dirname(node),
        installPath,
        home: os.homedir(),
      }),
      ...(onceUponHome ? { onceUponHome } : {}),
    }),
  );
  const failed = await loadLaunchAgent(file, uid, run);
  if (failed) {
    throw new Error(`wrote ${file}, but launchctl would not load it: ${failed}`);
  }
  const lines = [
    `Installed ${file}: the bridge starts at login, from ${bridgeDir}, on ${node}. It logs to ${path.join(home, 'bridge.log')}.`,
    'Deploys restart it with launchctl kickstart -k.',
  ];
  if (listenerPid(port)) {
    lines.push(
      `A bridge already holds port ${port}, so the one launchd just started exited. launchd does not manage that one until the next deploy, or: launchctl kickstart -k gui/${uid}/${LAUNCH_LABEL}`,
    );
  }
  return lines;
}

export async function uninstallLaunchAgent(
  options: Pick<LaunchAgentOptions, 'agentsDir' | 'uid' | 'run'>,
): Promise<string[]> {
  const {
    agentsDir = defaultAgentsDir(),
    uid = process.getuid?.() ?? 0,
    run = runCommand,
  } = options;
  const { pid } = await launchJob(uid, run);
  await unloadLaunchAgent(uid, run);
  removeLaunchAgent(launchAgentFile(agentsDir));
  const removed = `Removed ${launchAgentFile(agentsDir)}; the bridge no longer starts at login.`;
  // booting a job out ends its process, so the bridge launchd ran stops with it
  return pid
    ? [
        `${removed} The bridge launchd was running (pid ${pid}) stopped with it: start one with once-upon serve.`,
      ]
    : [`${removed} A bridge started by hand keeps running.`];
}
