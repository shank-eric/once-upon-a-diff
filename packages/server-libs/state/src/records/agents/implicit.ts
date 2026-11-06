/**
 * Implicit cards (ADR-27): work that did not start in the backlog is its own card, and the card is the run. `agent start` with
 * no `--card` mints an `ic_` id on its start row (registry.ts), and every later run that names the id is on that card. There
 * is no row for the card anywhere: it is read here, from the runs, so a start is one row in one file. The first run's start row is
 * the card: its task is the title, its repo the card's, its session the one that holds the claim. A later run may fill a branch
 * the card has none of. `backlog adopt` writes the card into backlog.jsonl under the same id, after which the backlog's is the
 * card and this one drops out (queues/backlog/implicit.ts). Pure.
 */
import { isImplicitCard } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from './ledger.ts';

/** A title is the first line of the first run's task, cut at this many characters. */
export const IMPLICIT_TITLE_MAX = 80;

/** One implicit card as its runs tell it. */
export interface ImplicitCard {
  id: string;
  /** the first line of the first run's task */
  title: string;
  /** the first run's whole task, for the card's note when it is adopted */
  task: string;
  repo: string | null;
  /** the latest branch any run named: a later run fills one the first had none of */
  branch: string | null;
  /** the first run's launching session and name: the claim */
  sid: string;
  agent: string;
  /** when the first run started, as an ISO time */
  at: string;
  /** every run on the card, oldest first (an agent's earlier runs and its latest) */
  runs: LedgerAgent[];
}

const startedAt = (run: LedgerAgent): number => run.started?.getTime() ?? 0;

/** The first line of a task, cut to a title. */
export function implicitTitle(task: string | null | undefined): string {
  const line =
    (task ?? '')
      .split('\n')
      .find((one) => one.trim())
      ?.trim() ?? '';
  return line.length > IMPLICIT_TITLE_MAX
    ? `${line.slice(0, IMPLICIT_TITLE_MAX).trimEnd()}...`
    : line;
}

/** The implicit cards the agents' runs make, in the order their first runs started. */
export function implicitCards(agents: LedgerAgent[]): ImplicitCard[] {
  const byId = new Map<string, LedgerAgent[]>();
  for (const run of agents.flatMap((agent) => [...(agent.earlier ?? []), agent])) {
    if (run.card && isImplicitCard(run.card)) {
      byId.set(run.card, [...(byId.get(run.card) ?? []), run]);
    }
  }
  return [...byId.entries()]
    .map(([id, found]) => {
      const runs = found.sort((first, second) => startedAt(first) - startedAt(second));
      const first = runs[0];
      return {
        id,
        title: implicitTitle(first.task) || first.name,
        task: first.task ?? '',
        repo: runs.find((run) => run.repo)?.repo ?? null,
        branch: [...runs].reverse().find((run) => run.branch)?.branch ?? null,
        sid: first.sid,
        agent: first.name,
        at: first.started?.toISOString() ?? '',
        runs,
      };
    })
    .sort((first, second) => startedAt(first.runs[0]) - startedAt(second.runs[0]));
}
