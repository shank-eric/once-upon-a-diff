// what the tests that drive the agent registry share: the isolation env, and the claim event and the runs with a chosen time
import '@once-upon-a-diff/test-kit/env';
import { appendFileSync } from 'node:fs';
import { AgentRegistry } from '../src/records/agents/registry.ts';
import type { AgentKind, AgentResult } from '../src/records/agents/agent-types.ts';

/**
 * A claim event stamped `stamp`: the store stamps the real clock, and a fixture's ledger is days old, so a test that needs the
 * claim made while a fixture run was going writes it with the time it means.
 */
export function claimAt(
  store: { file: string },
  id: string,
  agent: string,
  stamp: string,
  sid?: string,
): void {
  appendFileSync(
    store.file,
    JSON.stringify({ op: 'claim', id, agent, ...(sid ? { sid } : {}), by: 'test', at: stamp }) +
      '\n',
  );
}

/** One registered agent's run as a test sets it up: its start, then where it stands now and when it got there. */
export interface AgentRun {
  sid: string;
  name: string;
  /** a finished helper sits in Done, a stopped or failed one in Waiting (agent-home.ts) */
  kind?: AgentKind;
  task?: string;
  model?: string;
  effort?: string;
  lane?: string;
  repo?: string;
  branch?: string;
  pr?: number;
  card?: string;
  cwd?: string;
  notes?: string;
  standing?: boolean;
  started: Date | string;
  /** a state event or a finish after the start, at `at` */
  now?: {
    state: 'waiting' | 'review' | 'plan' | 'fixing' | 'running' | 'done' | 'failed' | 'stopped';
    at: Date | string;
    outcome?: string;
    findings?: number;
    notes?: string;
    result?: AgentResult;
  };
  beat?: { n: number; of: number; step: string; note?: string; at: Date | string };
}

/** Registers each run in `home`'s agent registry, in order (a second run of the same sid and name is a rerun). */
export function registerRuns(home: string, ...runs: AgentRun[]): AgentRegistry {
  const registry = new AgentRegistry(home);
  const when = (stamp: Date | string) => new Date(stamp);
  for (const run of runs) {
    const { sid, name } = run;
    registry.start({
      sid,
      name,
      kind: run.kind ?? 'helper',
      task: run.task || `${name}'s task`,
      model: run.model ?? null,
      effort: run.effort ?? null,
      lane: run.lane ?? null,
      repo: run.repo ?? null,
      branch: run.branch ?? null,
      pr: run.pr ?? null,
      card: run.card ?? null,
      cwd: run.cwd ?? null,
      notes: run.notes ?? null,
      standing: run.standing,
      at: when(run.started),
    });
    if (run.beat) {
      registry.beat(name, { ...run.beat, sid, at: when(run.beat.at) });
    }
    const now = run.now;
    if (!now) {
      continue;
    }
    if (now.state === 'done' || now.state === 'failed' || now.state === 'stopped') {
      registry.finish(name, {
        sid,
        state: now.state,
        outcome: now.outcome ?? null,
        findings: now.findings ?? null,
        notes: now.notes ?? null,
        result: now.result,
        at: when(now.at),
      });
    } else {
      registry.state(name, {
        sid,
        state: now.state,
        outcome: now.outcome ?? null,
        findings: now.findings ?? null,
        notes: now.notes ?? null,
        at: when(now.at),
      });
    }
  }
  return registry;
}
