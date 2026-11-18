/**
 * The last transcript write of each open author and critic run, for the CLI's sweep (registry.ts `sweep`): the same adapter
 * answer the board's dead-run rule reads (a run holding or waiting for a heavy lock counts as writing now). Empty when nothing
 * is open or on any failure: no answer is no verdict, and the sweep's 24-hour rule stands.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { SubagentLiveness } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import { SWEPT_STATES } from '@once-upon-a-diff/state/records/agents/auto-end';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';

const SWEPT_KINDS = ['author', 'critic'];

export async function liveWrites(
  home: string,
  agents: LedgerAgent[],
  nowMs: number = Date.now(),
): Promise<Map<string, number>> {
  try {
    const runs = agents
      .filter(
        (agent) =>
          SWEPT_STATES.includes(agent.state) &&
          SWEPT_KINDS.includes(agent.kind as string) &&
          !agent.standing &&
          agent.started,
      )
      .map((agent) => ({
        sid: agent.sid,
        name: agent.name,
        startedMs: (agent.started as Date).getTime(),
      }));
    if (!runs.length) {
      return new Map();
    }
    return await new SubagentLiveness().lastWrite(
      readSettings(home).board.projectsDir,
      runs,
      nowMs,
    );
  } catch {
    return new Map();
  }
}
