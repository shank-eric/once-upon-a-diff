/*
 * The CLI's argument parsing: `once-upon <command> [--flag value]... [words]`.
 * A flag without a value is true; bare words go in opts._.
 */
import type { CliOpts } from '../types.ts';

export function parseArgs(argv: string[]): { command: string | undefined; opts: CliOpts } {
  const [command, ...rest] = argv;
  const opts: CliOpts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      (opts._ ||= []).push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    let value: string | true = true;
    if (next !== undefined && !next.startsWith('--')) {
      value = next;
      i++;
    }
    opts[key] = value;
  }
  return { command, opts };
}
