/* Reading a command's flags the way several commands share: a text flag, and a body from a file or the flag. */
import { readFileSync } from 'node:fs';
import type { CliOpts } from './types.ts';

/** A text flag's value, or null when it is missing, empty or bare (`--flag` alone parses as true). */
export const given = (value: unknown): string | null =>
  value && value !== true ? String(value) : null;

/**
 * A body from `--body-file F` (`-` reads stdin) or `--body TEXT`, the file first, or null when neither was given.
 * `readFile` is for tests: it gets the path, or 0 for stdin.
 */
export function bodyText(
  opts: CliOpts,
  readFile: (file: string | 0) => string = (file) => readFileSync(file, 'utf8'),
): string | null {
  const file = given(opts['body-file']);
  if (file) {
    return readFile(file === '-' ? 0 : file);
  }
  return given(opts.body);
}

/**
 * The free-text flags that may be long: each also takes `--<flag>-file PATH`, and `--<flag> -` reads stdin. Short values
 * stay inline. Long text must not go through argv: an outside watchdog (the machine's endpoint security) SIGKILLs the
 * node process (exit 137) when a single argument passes about 1,000 bytes, before any of this code runs.
 * (`--body` has its own pair, `--body-file`, in bodyText.)
 */
export const LONG_TEXT_FLAGS = ['note', 'outcome', 'task', 'title', 'text'] as const;

/**
 * The opts with each long-text flag settled: `--note-file F` (or `--note -`, stdin) replaces `--note`'s value with the
 * file's text (CRLF read as LF), minus one trailing newline, and the `-file` key is gone. Both forms at once, a bare
 * `--note-file`, empty stdin and stdin asked for twice are errors. `readFile` is for tests: it gets the path, or 0 for stdin.
 */
export function resolveLongText(
  opts: CliOpts,
  readFile: (file: string | 0) => string = (file) => readFileSync(file, 'utf8'),
): CliOpts {
  const resolved: CliOpts = { ...opts };
  let stdinFlag: string | null = null;
  for (const flag of LONG_TEXT_FLAGS) {
    const key = `${flag}-file`;
    const file = opts[key];
    const inline = opts[flag];
    if (file === undefined && inline !== '-') {
      continue;
    }
    if (file !== undefined && inline !== undefined) {
      throw new Error(`give --${flag} or --${key}, not both`);
    }
    const from = file === undefined ? '-' : file;
    if (typeof from !== 'string') {
      throw new Error(`--${key} needs a path (- reads stdin)`);
    }
    if (from === '-') {
      if (stdinFlag) {
        throw new Error(`stdin can feed one flag: --${stdinFlag} and --${flag} both asked for it`);
      }
      stdinFlag = flag;
    }
    let text: string;
    try {
      text = readFile(from === '-' ? 0 : from);
    } catch (err) {
      throw new Error(
        `cannot read ${from === '-' ? 'stdin' : from} for --${flag}: ${(err as Error).message}`,
      );
    }
    // empty stdin is a pipe that was never fed (or closed), not a request to clear: an empty file still clears on purpose
    if (from === '-' && !text.trim()) {
      throw new Error(`stdin for --${flag} was empty: nothing was changed`);
    }
    delete resolved[key];
    // CRLF reads as LF (a lone \r would clean() to a space and store "x \ny"), then one trailing newline goes
    resolved[flag] = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  }
  return resolved;
}
