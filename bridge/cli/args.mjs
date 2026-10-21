/*
 * The CLI's argument parsing: `diff-story <command> [--flag value]... [words]`.
 * A flag without a value is true; --root repeats; bare words go in opts._.
 */

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { root: [] };
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
    if (key === 'root') {
      opts.root.push(value);
    } else {
      opts[key] = value;
    }
  }
  return { command, opts };
}
