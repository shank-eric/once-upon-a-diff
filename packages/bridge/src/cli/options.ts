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
