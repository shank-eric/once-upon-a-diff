/**
 * The file Claude Code writes next to a subagent's transcript: `<projects>/<proj>/<session>/subagents/agent-<id>.jsonl` has
 * `agent-<id>.meta.json` beside it, with the Agent tool's `description` (the house form is `<name>: <task>`), `agentType` and,
 * on newer versions, the tool's `name`. Read only by `agent auto-finish` to tell which registered run a stopped subagent was.
 */
import { readFileSync } from 'node:fs';

export interface SubagentMeta {
  name: string | null;
  description: string | null;
}

/** The meta file beside a subagent transcript (`…/agent-X.jsonl`), or null when there is none or it is not an object of text fields. */
export function readSubagentMeta(transcript: string): SubagentMeta | null {
  if (!transcript.endsWith('.jsonl')) {
    return null;
  }
  try {
    const meta: unknown = JSON.parse(
      readFileSync(`${transcript.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8'),
    );
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return null;
    }
    const field = (key: string) => {
      const value = (meta as Record<string, unknown>)[key];
      return typeof value === 'string' && value ? value : null;
    };
    return { name: field('name'), description: field('description') };
  } catch {
    return null;
  }
}
