/*
 * A run whose subagent has gone quiet. Claude Code writes each subagent's transcript as it works (adapters/claude-sessions/
 * subagent-liveness.ts finds it), so a transcript that keeps changing is a run that is alive, and a run that has written nothing
 * and logged nothing for QUIET_MS is dead: shown ended, so it no longer holds its card in Working or a build slot. A write of
 * the transcript counts as a sign of life like a beat does (the ledger's `lastEvent`), so the stale rules that read it (24 hours,
 * a storyteller's hour) see a working run as alive however long its ledger has been silent. Pure: the board never writes, so the
 * CLI (`agent sweep`, the one-open-author guard) still sees the run open until its own 24-hour rule, and a run that writes again
 * simply shows open again. A run with no transcript found has no entry and is left to those rules. Which runs, and how they end,
 * is the SubagentStop hook's (state/records/agents/auto-end.ts), so the two ways a stopped subagent ends read the same.
 */
import { QUIET_MS } from '@once-upon-a-diff/state/records/agents/events';
import { canAutoEnd, endOfStopped } from '@once-upon-a-diff/state/records/agents/auto-end';
import { lastActivity, type LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import {
  livenessKey,
  type LivenessQuery,
} from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';

/** The open runs whose transcript is worth looking for (those `endDeadRuns` could end), as the adapter's queries. */
export function runsToJudge(agents: LedgerAgent[]): LivenessQuery[] {
  return agents
    .filter((agent) => canAutoEnd(agent) && agent.started)
    .map((agent) => ({
      sid: agent.sid,
      name: agent.name,
      startedMs: (agent.started as Date).getTime(),
    }));
}

/**
 * The agents with each quiet run shown ended when it went dead (QUIET_MS after its last sign of life), and each run with a transcript written after its last
 * event shown with that write as its last event. `lastWrite` is the adapter's answer (ms per `sid:name`); an entry that is not a
 * positive number is no answer.
 */
export function endDeadRuns(
  agents: LedgerAgent[],
  lastWrite: ReadonlyMap<string, number>,
  nowMs: number,
): LedgerAgent[] {
  if (!lastWrite.size) {
    return agents;
  }
  return agents.map((agent) => {
    const wrote = lastWrite.get(livenessKey(agent));
    if (!wrote || !Number.isFinite(wrote) || wrote <= 0 || !canAutoEnd(agent)) {
      return agent;
    }
    const logged = lastActivity(agent)?.getTime() ?? 0;
    const sign = Math.max(wrote, logged);
    if (nowMs - sign > QUIET_MS) {
      // dead from `sign + QUIET_MS` (the moment the rule says so): that is when it ended and when its stay begins, so a
      // finished run's card (30 minutes, or an author's hour) is shown for its stay from here, not from a sign already past
      const died = new Date(sign + QUIET_MS);
      return {
        ...agent,
        ...endOfStopped(agent),
        review: false,
        ended: died,
        lastEvent: died,
      };
    }
    return wrote > logged ? { ...agent, lastEvent: new Date(wrote) } : agent;
  });
}
