/*
 * Running the bridge: serve, setup (the port and token for the extension's
 * options) and token.
 */
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { saveConfig, newToken, readSettings } from '../../config/settings.ts';
import { createBridge } from '../../server/index.ts';
import { readBridgeFile, tokenFingerprint } from '../../server/bridge-file.ts';
import { pidAlive } from '../../util/pid.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { Bridge } from '../../server/index.ts';
import type { Command } from '../../types.ts';

/** What is on a port: this home's bridge, one started with another token, something else, or nothing. */
export type PortState = 'ours' | 'old-token' | 'foreign' | 'free';

/** Whether something listens on the port: a port already listening can't be bound again. */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

/**
 * Is this home's bridge on the port? Answered without calling it. A port something listens on is taken, and it's ours
 * when bridge.json (which the bridge writes when it starts listening) names a live process and this port. A bridge
 * started before the token was rotated is told apart by the token's fingerprint in that file. Anything else on the port
 * is "foreign": another program, another home's bridge, or a bridge whose file is gone.
 */
export async function portState(
  home: string,
  port: number | string,
  token?: string,
): Promise<PortState> {
  const number = Number(port);
  if (!(await portTaken(number))) {
    return 'free';
  }
  const file = readBridgeFile(home);
  if (!file || file.port !== number || !pidAlive(file.pid)) {
    return 'foreign';
  }
  return token && file.token !== tokenFingerprint(token) ? 'old-token' : 'ours';
}

/** Starts the bridge on 127.0.0.1 and resolves once it listens. */
export function serve(
  home: string,
  cfg: Config,
  opts: { port?: unknown; [flag: string]: unknown },
): Promise<Bridge> {
  const port = Number(opts.port || cfg.port);
  // the bridge keeps its own log in <home>/bridge.log, for `once-upon doctor`
  const logFile = path.join(home, 'bridge.log');
  if (existsSync(logFile)) {
    chmodSync(logFile, 0o600); // an older bridge may have made it readable by others
  }
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`once-upon bridge: ${line}\n`);
    try {
      appendFileSync(logFile, text, { mode: 0o600 });
    } catch {
      /* the log is a convenience */
    }
  };
  const server = createBridge({
    home,
    token: cfg.token,
    log,
    extensionIds: readSettings(home).extensionIds,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(
        `listening on http://127.0.0.1:${port}, pid ${process.pid} (stories: ${server.stories.list().length}, inbox: ${server.inbox.file})`,
      );
      resolve(server);
    });
  });
}

export const bridgeCommands: Command[] = [
  {
    name: 'serve',
    usage: [
      '  once-upon serve   [--port N]                                  run the bridge on 127.0.0.1',
    ],
    async run(home, cfg, opts) {
      await serve(home, cfg, opts);
    },
  },
  {
    name: 'setup',
    usage: [
      "  once-upon setup                                               print the port and token to paste into the extension's options",
    ],
    run(home, cfg) {
      out(`Bridge port:  ${cfg.port}`);
      out(`Bridge token: ${cfg.token}`);
      out('');
      out(
        'Paste both into the extension: chrome://extensions → Once Upon a Diff → Details → Extension options.',
      );
      out(`Then run: ${path.relative(process.cwd(), process.argv[1]) || 'once-upon'} serve`);
    },
  },
  {
    name: 'token',
    usage: [
      '  once-upon token   [--rotate]                                  print (or replace) the token',
    ],
    run(home, cfg, opts) {
      if (opts.rotate) {
        cfg.token = newToken();
        saveConfig(cfg, home);
        out('New token (paste it into the extension options, then restart the bridge):');
      }
      out(cfg.token);
    },
  },
];
