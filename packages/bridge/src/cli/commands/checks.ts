// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * `once-upon doctor`: is everything connected?
 */
import { doctor } from '../doctor.ts';
import { out } from '../output.ts';

async function runDoctor(home, cfg, opts) {
  const ok = await doctor(home, cfg, { port: opts.port, out });
  if (!ok) {
    process.exitCode = 1;
  }
}

export const checkCommands = [
  {
    name: 'doctor',
    usage: [
      '  once-upon doctor  [--port N]                                  is everything connected? a pass/fail list with fixes',
    ],
    run: runDoctor,
  },
];
