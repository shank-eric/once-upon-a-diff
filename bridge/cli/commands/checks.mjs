/*
 * `diff-story doctor`: is everything connected?
 */
import { doctor } from '../doctor.mjs';
import { out } from '../output.mjs';

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
      '  diff-story doctor  [--port N]                                  is everything connected? a pass/fail list with fixes',
    ],
    run: runDoctor,
  },
];
