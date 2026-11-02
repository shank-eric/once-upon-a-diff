/*
 * Text files kept outside the bridge's home: the agent ledger and its progress file (the settings board_ledger_file and
 * board_progress_file). Both are read from their tail, so a long history costs nothing. The board writes to the ledger
 * only through appendLine, for a card's Finish.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { appendText } from './files.ts';

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

/** Appends one line to a text file that other tools append to as well, starting a new line first when the file doesn't end with one. */
export function appendLine(file: string, line: string): void {
  let lead = '';
  let handle: number | null = null;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(handle, last, 0, 1, size - 1);
      lead = last.toString('utf8') === '\n' ? '' : '\n';
    }
  } catch {
    // no file yet: it is made by the append
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
  appendText(file, `${lead}${line}\n`);
}
