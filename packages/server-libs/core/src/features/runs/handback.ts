/*
 * An agent's hand-back: `once-upon handback NAME`. Done (the default) records what the run made without the agent typing it:
 * the run's branch tip, read from `refs/heads/<branch>` in the run's checkout (a branch's ref is the same from every worktree; the
 * run's cwd is the main checkout, whose HEAD is never the author's), the branch and the card. A planner or a capped author with
 * no commit of its own records the card alone. Waiting, plan and review move the run's state. The caller runs carry-approval on
 * what comes back, as `agent finish` does (core's features never import each other).
 */
import { commitLog, mergeBase } from '@once-upon-a-diff/adapters/git';
import { branchTip } from '@once-upon-a-diff/state/records/agents/made';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import type { AgentResult } from '@once-upon-a-diff/state/records/agents/agent-types';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { isImplicitCard } from '@once-upon-a-diff/terms/ids';
import { defaultBranch } from './checkout.ts';
import { runRegistry, type Mirror } from './registry.ts';

export interface HandbackInput {
  /** done (the default), failed or stopped end the run; waiting, plan or review move it */
  state?: string | null;
  outcome?: string | null;
  findings?: string | null;
  /** the run's session when the caller names it; else the caller's own, else the one session with an open run of the name */
  sid?: string | null;
  prefer?: string | null;
  /** the planner's hand-back: state plan, outcome "plan written" */
  plan?: boolean;
  /** an author that finishes with no commit of its own (a capped one) records the card only */
  noCommit?: boolean;
}

export interface HandedBack {
  run: LedgerAgent;
  ended: boolean;
  warnings: string[];
}

const MOVES = ['waiting', 'plan', 'review'];

/** The session whose run of this name the hand-back is about: the named one, the caller's own, or the only one with an open run. */
function sessionOf(runs: LedgerAgent[], input: HandbackInput): string | undefined {
  if (input.sid) {
    return input.sid;
  }
  if (input.prefer && runs.some((one) => one.sid === input.prefer)) {
    return input.prefer;
  }
  const open = [...new Set(runs.filter(runIsOpen).map((one) => one.sid))];
  return open.length === 1 ? open[0] : undefined;
}

export function handbackRun(
  home: string,
  name: string,
  input: HandbackInput = {},
  options: { mirror?: Mirror; warn?: (line: string) => void } = {},
): HandedBack {
  const registry = runRegistry(home, options.mirror);
  const warnings: string[] = [];
  const warn = (line: string) => {
    warnings.push(line);
    options.warn?.(line);
  };
  const runs = registry.agents().filter((one) => one.name === name);
  const sid = sessionOf(runs, input);
  const state = input.plan ? 'plan' : (input.state ?? 'done');
  const outcome = input.outcome || (input.plan ? 'plan written' : null);
  if (MOVES.includes(state)) {
    if (!outcome) {
      throw new Error(`--state ${state} needs --outcome TEXT (the question, or the story id)`);
    }
    const moved = registry.state(
      name,
      { state: state as 'waiting', outcome, findings: input.findings, sid, prefer: input.prefer },
      warn,
    );
    return { run: moved, ended: false, warnings };
  }
  const run = runs.filter((one) => !sid || one.sid === sid).find(runIsOpen);
  const result: AgentResult = {};
  if (run && state === 'done' && run.kind === 'author') {
    const card = run.card && !isImplicitCard(run.card) ? run.card : null;
    if (card) {
      result.card = card;
    }
    // a planner (its last state was plan) and an author told --no-commit made no commit to record
    if (run.state !== 'plan' && !input.noCommit && run.branch) {
      const tip = branchTip(run.cwd, run.branch);
      const base = branchTip(run.cwd, defaultBranch(run.cwd ?? ''));
      if (tip && tip !== run.tip && tip !== base) {
        result.commit = tip;
        result.branch = run.branch;
        warnIfNotOne(run.cwd ?? '', run.branch, tip, warn);
      } else {
        warn(
          `once-upon: ${run.branch} has no commit of its own since ${name} started: finishing with the card only`,
        );
      }
    }
  }
  const finished = registry.finish(
    name,
    {
      state: state as 'done',
      outcome,
      result,
      findings: input.findings,
      sid,
      prefer: input.prefer,
    },
    warn,
  );
  return { run: finished, ended: true, warnings };
}

/** The one-commit rule: a branch handed back is one commit above the default branch. Only a warning: a capped author hands back what it has. */
function warnIfNotOne(
  cwd: string,
  branch: string,
  tip: string,
  warn: (line: string) => void,
): void {
  try {
    const base = defaultBranch(cwd);
    const count = commitLog(cwd, [`${mergeBase(cwd, `refs/heads/${base}`, tip)}..${tip}`]).length;
    if (count !== 1) {
      warn(
        `once-upon: ${branch} has ${count} commits above ${base}: the rule is one commit, amended`,
      );
    }
  } catch {
    /* no default branch to count from: nothing to say */
  }
}
