/**
 * The file Claude Code writes next to a subagent's transcript: `<projects>/<proj>/<session>/subagents/agent-<id>.jsonl` has
 * `agent-<id>.meta.json` beside it, with the Agent tool's `description` (the house form is `<name>: <task>`), `agentType` and,
 * on newer versions, the tool's `name`. Read to tell which registered run a subagent is: by `agent auto-finish` for a stopped one
 * and by the board's liveness check (claude-sessions/subagent-liveness.ts) for a running one.
 */
import { readFileSync } from 'node:fs';
import { AGENT_NAME_RE } from '@once-upon-a-diff/terms/patterns';

/** The house form of an Agent description: `<name>: <task>`. */
const DESCRIPTION_NAME = /^([a-z0-9][a-z0-9-]*):/;

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

/** The run name a subagent's meta gives: the tool's `name`, else the description's `name:` prefix. Null when it gives neither. */
export function runNameOf(meta: SubagentMeta | null): string | null {
  if (meta?.name && AGENT_NAME_RE.test(meta.name)) {
    return meta.name;
  }
  return meta?.description?.match(DESCRIPTION_NAME)?.[1] ?? null;
}
