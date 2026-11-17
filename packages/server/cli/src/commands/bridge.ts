/*
 * Running the bridge: serve, setup (the port and token for the extension's
 * options) and token.
 */

import path from 'node:path';
import { statusLineStep } from '@once-upon-a-diff/core/features/sessions/status-line-setup';
import { newToken, saveToken, tokenFile } from '@once-upon-a-diff/foundation/settings';

import { out } from '../output.ts';

import type { Command } from '../types.ts';
import { serve } from '@once-upon-a-diff/core/orchestration/bridge/bridge';

/**
 * The token as a line for the terminal, or the file it is in. A session's Bash tool is not a terminal, and what it prints lands in
 * its transcript, so the value prints only on a terminal (a script reads the token file).
 */
const tokenLine = (home: string, token: string): string =>
  process.stdout.isTTY
    ? token
    : `(not printed: it is in ${tokenFile(home)}; run this in your own terminal)`;

export const bridgeCommands: Command[] = [
  {
    name: 'serve',
    needsConfig: true,
    usage: [
      '  once-upon serve   [--port N]                                  run the bridge on 127.0.0.1',
    ],
    async run(home, cfg, opts) {
      await serve(home, cfg, opts);
    },
  },
  {
    name: 'setup',
    needsConfig: true,
    usage: [
      "  once-upon setup                                               print the port and token for the extension's options, and the status line step (the token only on a terminal)",
    ],
    run(home, cfg) {
      out(`Bridge port:  ${cfg.port}`);
      out(`Bridge token: ${tokenLine(home, cfg.token)}`);
      out('');
      out(
        'Paste both into the extension: chrome://extensions → Once Upon a Diff → Details → Extension options.',
      );
      out(`Then run: ${path.relative(process.cwd(), process.argv[1]) || 'once-upon'} serve`);
      out('');
      for (const line of statusLineStep(home)) {
        out(line);
      }
    },
  },
  {
    name: 'token',
    needsConfig: true,
    usage: [
      '  once-upon token   [--rotate]                                  print (or replace) the token, on a terminal only',
    ],
    run(home, cfg, opts) {
      let token = cfg.token;
      if (opts.rotate) {
        token = newToken();
        saveToken(token, home);
        out('New token (paste it into the extension options, then restart the bridge):');
      }
      out(tokenLine(home, token));
    },
  },
];
