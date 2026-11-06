/*
 * The check a writer makes on a line or record it is about to put in a file the CLI and the bridge share (the formats are
 * contracts/src/files/schemas.ts, and strict.ts for what a writer may give). A line the readers would skip (the lenient
 * `read`) or that fails the strict check is a writer bug, and is refused: written, it would be invisible to every reader,
 * so the writer would never hear of it. The error is the CLI's `once-upon: ...` line and a server route's 500; the file is
 * untouched. Only what no current writer can produce is refused (strict.ts says how that is kept true): what a live row or
 * flow can still hold is a warning the caller prints (`warn`), and the write goes on.
 */
import path from 'node:path';

/**
 * Throws when `read` (one of the contracts package's readers) refuses `value`, or `strict` (one of strict.ts's checks) lists a
 * problem with it.
 */
export function checkWrite(
  file: string,
  value: unknown,
  read: (value: unknown) => unknown,
  strict?: (value: unknown) => string[],
): void {
  const name = path.basename(file);
  const shown = () => JSON.stringify(value).slice(0, 300);
  if (read(value) === null) {
    throw new Error(`${name}: refused, no reader would take this line: ${shown()}`);
  }
  const problems = strict?.(value) ?? [];
  if (problems.length) {
    throw new Error(`${name}: refused, ${problems.join('; ')}: ${shown()}`);
  }
}
