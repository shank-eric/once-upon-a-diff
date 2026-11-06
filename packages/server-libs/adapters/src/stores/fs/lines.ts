/*
 * Line-oriented text files other tools read and append to: the agent ledger and its progress file (the settings
 * board_ledger_file and board_progress_file, outside the bridge's home), which the agent registry writes its log lines
 * to. Nothing here reads them back: the board reads agents from the registry only.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { appendText } from './files.ts';

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
