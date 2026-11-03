/*
 * <home>/agents.jsonl: the registered agents' events. One JSON event a line, appended and never rewritten, so the CLI
 * (in-process) and the bridge (a board Finish) can both write without a lock. What the events mean, and how they fold
 * into agents, is the ledger service's (services/ledger/events.ts, registry.ts).
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { appendText } from './files.ts';

/** The file's text, or '' when there is no file yet. */
export function readAgentsFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
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
    return false;
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
}

/** Appends one event as a line, starting a new line first when the file doesn't end with one. The file is the user's alone (0600). */
export function appendAgentEvent(file: string, event: Record<string, unknown>): void {
  appendText(file, `${lacksNewline(file) ? '\n' : ''}${JSON.stringify(event)}\n`, 0o600);
}
