/*
 * The CLI's argument parsing: `diff-story <command> [--flag value]... [words]`.
 * A flag without a value is true; --root and --exclude-agent repeat; -o is
 * an output file; bare words go in opts._.
 */

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { root: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-o') {
      opts.o = rest[++i];
      continue;
    }
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
    } else if (key === 'exclude-agent') {
      (opts.excludeAgents ||= []).push(value);
    } else {
      opts[key] = value;
    }
  }
  return { command, opts };
}
