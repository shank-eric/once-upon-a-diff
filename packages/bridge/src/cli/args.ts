// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The CLI's argument parsing: `once-upon <command> [--flag value]... [words]`.
 * A flag without a value is true; bare words go in opts._.
 */

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      (opts._ ||= []).push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith('--')) {
      value = next;
      i++;
    }
    opts[key] = value;
  }
  return { command, opts };
}
