/*
 * The CLI's argument parsing: `once-upon <command> [--flag value]... [words]`.
 * A flag without a value is true; bare words go in opts._. After a bare `--` everything is a word, even `--x`.
 * `heavy` takes only words: what follows its name is another program's command line.
 */
import type { CliOpts } from './types.ts';

/** Flags that never take a value, so a bare word after one stays a word. */
const BOOLEAN_FLAGS = new Set(['dry-run', 'off']);

export function parseArgs(argv: string[]): { command: string | undefined; opts: CliOpts } {
  const [command, ...rest] = argv;
  const opts: CliOpts = {};
  // `heavy NAME COMMAND...`: every word after the command is a word, so the command's own flags (`yarn lint --fix`) stay its own
  if (command === 'heavy') {
    return { command, opts: { _: rest } };
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') {
      (opts._ ||= []).push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      (opts._ ||= []).push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    let value: string | true = true;
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      value = next;
      i++;
    }
    opts[key] = value;
  }
  return { command, opts };
}
