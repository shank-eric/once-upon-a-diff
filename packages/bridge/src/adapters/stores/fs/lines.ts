/*
 * Line-oriented text files: the agent ledger and its progress file (the settings board_ledger_file and board_progress_file,
 * outside the bridge's home) and the JSONL logs (jsonl.ts). The ledger files are read from their tail, so a long history
 * costs nothing. The board writes to the ledger only through appendLine, for a card's Finish.
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

/** Whether the file's last byte is not a newline (a torn write or a hand edit), so the next line would glue onto it. */
function lacksNewline(file: string): boolean {
  let handle: number | null = null;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    if (size === 0) {
      return false;
    }
    const last = Buffer.alloc(1);
    readSync(handle, last, 0, 1, size - 1);
    return last.toString('utf8') !== '\n';
  } catch {
    return false; // no file yet: it is made by the append
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
}

/**
 * Appends one line to a text file that other tools append to as well, starting a new line first when the file doesn't end
 * with one. `mode` applies when the file is made: a file outside the home (the ledger) is given none.
 */
export function appendLine(file: string, line: string, mode?: number): void {
  appendText(file, `${lacksNewline(file) ? '\n' : ''}${line}\n`, mode);
}
