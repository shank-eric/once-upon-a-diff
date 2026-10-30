/*
 * <home>/backlog.jsonl: the board's Backlog column. One JSON event a line, appended and never rewritten, so the CLI
 * (in-process) and the bridge (page clicks) can both write without a lock. What the events mean, and how they fold into
 * items, is the backlog service's (services/backlog/backlog.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendText } from './files.ts';

/** The file's text, or '' when there is no file yet. */
export function readBacklogFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Appends one event as a line, stamped with the time. The file is the user's alone (0600). */
export function appendBacklogEvent(file: string, event: Record<string, unknown>): void {
  appendText(file, JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n', 0o600);
}
