/*
 * Running the bridge: serve, setup (the port and token for the extension's
 * options) and token.
 */

import path from 'node:path';
import { saveConfig, newToken } from '@once-upon-a-diff/core/foundation/settings';

import { out } from '../output.ts';

import type { Command } from '../types.ts';
import { serve } from '@once-upon-a-diff/core/orchestration/bridge/bridge';

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
