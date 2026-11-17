/*
 * `once-upon config get KEY`: one setting from config.json, so a session never has to print the file. The token is not a
 * setting and is never printed here.
 */
import { readConfigValues } from '@once-upon-a-diff/foundation/settings';

import { out } from '../output.ts';

import type { Command } from '../types.ts';

export const configCommands: Command[] = [
  {
    name: 'config',
    subs: ['get'],
    usage: [
      '  once-upon config  get KEY                                     one setting from config.json (a string as it is, else JSON); exit 1 when it is not set',
    ],
    run(home, _cfg, opts) {
      const [verb, key] = opts._ ?? [];
      if (verb !== 'get' || !key) {
        throw new Error('usage: once-upon config get KEY');
      }
      if (key === 'token') {
        throw new Error(
          'the token is not a setting and is never printed here: it is in ~/.once-upon/token',
        );
      }
      const values = readConfigValues(home);
      if (!Object.hasOwn(values, key) || values[key] === undefined || values[key] === null) {
        throw new Error(`${key} is not set in config.json`);
      }
      const value = values[key];
      out(typeof value === 'string' ? value : JSON.stringify(value));
    },
  },
];
