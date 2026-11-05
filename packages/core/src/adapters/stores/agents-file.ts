/*
 * <home>/agents.jsonl: the registered agents' events. One JSON event a line, appended and never rewritten, so the CLI
 * (in-process) and the bridge (a board Finish) can both write without a lock. What the events mean, and how they fold
 * into agents, is the ledger service's (core/src/records/agents/events.ts, registry.ts).
 */
import { appendLogLine, readLogText } from './fs/jsonl.ts';

/** The file's text, or '' when there is no file yet. */
export const readAgentsFile: (file: string) => string = readLogText;

/** Appends one event as a line (it carries its own time). The file is the user's alone (0600). */
export function appendAgentEvent(file: string, event: Record<string, unknown>): void {
  appendLogLine(file, event);
}
