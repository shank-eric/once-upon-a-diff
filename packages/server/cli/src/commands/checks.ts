/*
 * `once-upon doctor`: is everything connected?
 */
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

async function runDoctor(home: string, cfg: Config, opts: CliOpts) {
  const days = opts['keep-days'];
  if (days !== undefined && !(Number(days) >= 0)) {
    throw new Error('--keep-days takes a number of days, 0 or more');
  }
  const ok = await doctor(home, cfg, {
    port: opts.port as string | undefined,
    wait: Number(opts.wait) || 0,
    fix: opts.fix === true,
    ...(opts['keep-days'] === undefined ? {} : { keepDays: Number(opts['keep-days']) }),
    out,
  });
  if (!ok) {
    process.exitCode = 1;
  }
}

export const checkCommands: Command[] = [
  {
    name: 'doctor',
    usage: [
      '  once-upon doctor  [--port N] [--wait S]                       is everything connected? a pass/fail list with fixes',
      '                    (--wait: give a bridge that was just started up to S seconds to answer)',
      '  once-upon doctor --fix [--keep-days N]                        shrink agents.jsonl and inbox.jsonl: runs over N days old (14) on a done or dropped card, and old chapter reads,',
      '                    go; the old logs are kept as <file>.<yyyymmdd>.bak',
    ],
    run: runDoctor,
  },
];
