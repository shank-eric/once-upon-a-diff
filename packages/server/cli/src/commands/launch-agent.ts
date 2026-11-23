/*
 * `once-upon install-launch-agent [--uninstall]`: start the bridge at login through a LaunchAgent (macOS), or take it away.
 * The steps are core's (features/launch-agent/install.ts); this passes the home, the port and this script's own path.
 */
import {
  installLaunchAgent,
  uninstallLaunchAgent,
} from '@once-upon-a-diff/core/features/launch-agent/install';
import { out } from '../output.ts';
import type { Command } from '../types.ts';

export const launchAgentCommands: Command[] = [
  {
    name: 'install-launch-agent',
    usage: [
      '  once-upon install-launch-agent [--uninstall]                  start the bridge at login (a LaunchAgent, run from the main checkout on this Node); --uninstall removes it',
    ],
    async run(home, cfg, opts) {
      if (opts.uninstall) {
        for (const line of await uninstallLaunchAgent({})) {
          out(line);
        }
        return;
      }
      for (const line of await installLaunchAgent({
        home,
        entry: process.argv[1],
        port: cfg.port,
      })) {
        out(line);
      }
    },
  },
];
