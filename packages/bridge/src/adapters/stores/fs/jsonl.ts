/*
 * An append-only JSONL log: one JSON value a line, appended and never rewritten, so the CLI (in-process) and the bridge
 * can both write without a lock. agents.jsonl and backlog.jsonl are built on it; what the lines mean, and how they fold,
 * is each store's service's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendLine } from './lines.ts';

/** The log's text, or '' when there is no file yet. */
export function readLogText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Appends one value as a line, starting a new line first when the file doesn't end with one. The file is the user's alone (0600). */
export function appendLogLine(file: string, value: unknown): void {
  appendLine(file, JSON.stringify(value), 0o600);
}

/** The values in a log's text, oldest first. A line that isn't JSON (blank, half-written, hand-edited) is skipped; what each value must look like is the caller's to check. */
export function jsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split('\n')) {
    try {
      values.push(JSON.parse(line));
    } catch {
      // not a value: skipped
    }
  }
  return values;
}
