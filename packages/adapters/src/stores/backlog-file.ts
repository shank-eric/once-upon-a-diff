/*
 * <home>/backlog.jsonl: the board's Backlog column. One JSON event a line, appended and never rewritten, so the CLI
 * (in-process) and the bridge (page clicks) can both write without a lock. What the events mean, and how they fold into
 * items, is the backlog service's (state/src/queues/backlog/backlog.ts).
 */
import { appendLogLine, readLogText } from './fs/jsonl.ts';

/** The file's text, or '' when there is no file yet. */
export const readBacklogFile: (file: string) => string = readLogText;

/** Appends one event as a line, stamped with the time. The file is the user's alone (0600). */
export function appendBacklogEvent(file: string, event: Record<string, unknown>): void {
  appendLogLine(file, { ...event, at: new Date().toISOString() });
}
