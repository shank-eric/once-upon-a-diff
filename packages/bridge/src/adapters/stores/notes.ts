/*
 * Text files kept outside the bridge's home that the board only reads: the agent ledger and its progress file (the
 * settings board_ledger_file and board_progress_file). Both are read from their tail, so a long history costs nothing.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** The last `max` bytes of a text file ('' when it can't be read), cut to whole lines. */
export function tailOf(file: string, max: number): string {
  let handle: number | null = null;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    readSync(handle, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
}
