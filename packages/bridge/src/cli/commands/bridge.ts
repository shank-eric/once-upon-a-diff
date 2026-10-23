/*
 * Running the bridge: serve, setup (the port and token for the extension's
 * options) and token.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { saveConfig, newToken } from '../../config/settings.ts';
import { createBridge } from '../../server/index.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { Bridge } from '../../server/index.ts';
import type { Command } from '../../types.ts';

/** Is a bridge answering on this port with this token? */
export async function probe(port: number | string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    const health = (await response.json()) as { name?: string };
    return response.ok ? health.name === 'once-upon-bridge' : false;
  } catch {
    return false;
  }
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
