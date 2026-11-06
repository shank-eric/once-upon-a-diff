/*
 * The check a writer makes on a line or record it is about to put in a file the CLI and the bridge share (the formats are
 * contracts/src/files/schemas.ts). A writer that builds something its own schema refuses has a bug, but the line is written
 * anyway and the bug is logged: refusing it would lose an `agent finish` or a backlog event the user is waiting on. The
 * readers skip a line that fails, so a bad line costs that line only.
 */
import path from 'node:path';

/** Logs when `read` (one of the contracts package's readers) refuses `value`. */
export function noteIfMalformed(
  file: string,
  value: unknown,
  read: (value: unknown) => unknown,
): void {
  if (read(value) === null) {
    console.error(
      `${path.basename(file)}: a line was written that contracts/src/files/schemas.ts does not accept (readers will skip it): ${JSON.stringify(value).slice(0, 300)}`,
    );
  }
}
