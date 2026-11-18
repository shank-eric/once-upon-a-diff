/*
 * A subagent that stopped without finishing its run (the SubagentStop hook, extras/hooks/auto-finish-run.sh, calls
 * `once-upon agent auto-finish`): its run is ended here, so the board does not show it running forever. The hook's input has
 * no run name, so the run is found from the subagent's own files. The transcript sits at
 * <projects>/<proj>/<launching session>/subagents/agent-X.jsonl: the folder is the launching session (the first 8 of its id
 * are the run's `sid`), and agent-X.meta.json holds the Agent tool's `name` or a `<name>: <task>` description. A run is ended
 * only when exactly one registered run is named that way, in that session, and still open on beats (registry.ts `autoFinish`).
 * Anything else is a quiet no-op: a run is never guessed.
 */
import path from 'node:path';
import { readSubagentMeta, runNameOf } from '@once-upon-a-diff/adapters/subagent-meta';
import { SID_RE } from '@once-upon-a-diff/terms/patterns';
import { runRegistry } from './registry.ts';

/** The launching session's id from a subagent transcript's path, or null when it is not laid out as Claude Code does. */
function sessionOf(transcript: string): string | null {
  const folder = path.dirname(transcript);
  return path.basename(folder) === 'subagents' ? path.basename(path.dirname(folder)) : null;
}

/**
 * Ends the run of the subagent whose transcript this is. `session` is the hook's own `session_id`, used only when the path
 * names no session. Returns the run's name when it ended one, else null.
 */
export function autoFinishRun(
  home: string,
  input: { transcript: string | null; session: string | null },
): string | null {
  const sid = [input.transcript ? sessionOf(input.transcript) : null, input.session]
    .map((session) => session?.slice(0, 8) ?? '')
    .find((one) => SID_RE.test(one));
  const name = input.transcript ? runNameOf(readSubagentMeta(input.transcript)) : null;
  if (!name || !sid) {
    return null;
  }
  return runRegistry(home).autoFinish(sid, name)?.name ?? null;
}
