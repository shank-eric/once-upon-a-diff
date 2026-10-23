/*
 * `once-upon doctor`: is everything connected?
 */
import { doctor } from '../doctor.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

async function runDoctor(home: string, cfg: Config, opts: CliOpts) {
  const ok = await doctor(home, cfg, { port: opts.port as string | undefined, out });
  if (!ok) {
    process.exitCode = 1;
  }
}

export const checkCommands: Command[] = [
  {
    name: 'doctor',
    usage: [
      '  once-upon doctor  [--port N]                                  is everything connected? a pass/fail list with fixes',
    ],
    run: runDoctor,
  },
];
