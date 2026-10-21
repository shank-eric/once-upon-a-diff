/*
 * Running the bridge: serve, setup (the port and token for the extension's
 * options) and token.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { saveConfig, newToken } from '../../config/settings.mjs';
import { createBridge } from '../../server/index.mjs';
import { out } from '../output.mjs';

/** Is a bridge answering on this port with this token? */
export async function probe(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? (await response.json()).name === 'diff-story-bridge' : false;
  } catch {
    return false;
  }
}

function rootsOf(cfg, opts) {
  if (opts.root.length) {
    return opts.root.map((root) => path.resolve(root));
  }
  return cfg.roots && cfg.roots.length ? cfg.roots : undefined;
}

/** Starts the bridge on 127.0.0.1 and resolves once it listens. */
export function serve(home, cfg, opts) {
  const port = Number(opts.port || cfg.port);
  // the bridge keeps its own log in <home>/bridge.log, for `diff-story doctor`
  const logFile = path.join(home, 'bridge.log');
  const log = (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`diff-story bridge: ${line}\n`);
    try {
      appendFileSync(logFile, text, { mode: 0o600 });
    } catch {
      /* the log is a convenience */
    }
  };
  const server = createBridge({
    home,
    token: cfg.token,
    roots: rootsOf(cfg, opts),
    scratch: !opts['no-scratch'],
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

export const bridgeCommands = [
  {
    name: 'serve',
    usage: [
      '  diff-story serve   [--port N] [--root DIR]... [--no-scratch]   run the bridge on 127.0.0.1',
    ],
    async run(home, cfg, opts) {
      await serve(home, cfg, opts);
    },
  },
  {
    name: 'setup',
    usage: [
      "  diff-story setup                                               print the port and token to paste into the extension's options",
    ],
    run(home, cfg) {
      out(`Bridge port:  ${cfg.port}`);
      out(`Bridge token: ${cfg.token}`);
      out('');
      out(
        'Paste both into the extension: chrome://extensions → Diff Story Mode → Details → Extension options.',
      );
      out(`Then run: ${path.relative(process.cwd(), process.argv[1]) || 'diff-story'} serve`);
    },
  },
  {
    name: 'token',
    usage: [
      '  diff-story token   [--rotate]                                  print (or replace) the token',
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
