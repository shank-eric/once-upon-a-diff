/*
 * Ends a run, with the card checks: a critic on a card finishes with a findings count (a null would read as a pass).
 * The CLI's `agent finish` and the board's Finish both come here. An author's finish also teaches its card (ADR-29): a card with no
 * branch takes the one git found in the author's worktree, written before the finish row so a board built between the two writes
 * never sees a finished card with no branch (phase row 7).
 */
import type { FinishInput } from '@once-upon-a-diff/state/records/agents/registry';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { runRegistry, type Mirror } from './registry.ts';

/** The finish stamp: a card with no branch takes the branch the run's result names, unless it is a default branch (never stamp `main`). */
export const teachCard =
  (home: string, name: string): NonNullable<FinishInput['beforeFinish']> =>
  (agent, result) => {
    if (!agent.card || !result.branch || DEFAULT_BRANCHES.has(result.branch)) {
      return;
    }
    const store = new BacklogStore(home);
    const card = store.items().find((one) => one.id === agent.card);
    if (card && !card.branch && card.state !== 'dropped' && !card.landed_at) {
      store.link(card.id, { branch: result.branch, repo: card.repo ? null : agent.repo, by: name });
    }
  };

export function finishRun(
  home: string,
  name: string,
  input: FinishInput = {},
  options: { mirror?: Mirror; warn?: (line: string) => void } = {},
): LedgerAgent {
  return runRegistry(home, options.mirror).finish(
    name,
    { ...input, beforeFinish: input.beforeFinish ?? teachCard(home, name) },
    options.warn,
  );
}
