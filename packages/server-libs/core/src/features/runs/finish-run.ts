/*
 * Ends a run, with the card checks: a critic on a card finishes with a findings count (a null would read as a pass).
 * The CLI's `agent finish` and the board's Finish both come here. An author's finish also teaches its card (ADR-29): a card with no
 * branch takes the one git found in the author's worktree, written before the finish row so a board built between the two writes
 * never sees a finished card with no branch (phase row 7). A storyteller's finish (and its hand-back to review) links the story it
 * names in its outcome to its card, so the card never reaches Ready for review with no story.
 */
import type { FinishInput } from '@once-upon-a-diff/state/records/agents/registry';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { runRegistry, type Mirror } from './registry.ts';

/** The finish stamp: a card with no branch takes the branch the run's result names, unless it is a default branch (never stamp `main`). */
export const teachCard =
  (home: string, name: string, outcome?: string | null): NonNullable<FinishInput['beforeFinish']> =>
  (agent, result) => {
    linkStory(home, agent, outcome);
    if (!agent.card || !isFeatureBranch(result.branch)) {
      return;
    }
    const store = new BacklogStore(home);
    const card = store.items().find((one) => one.id === agent.card);
    if (card && !card.branch && card.state !== 'dropped' && !card.landed_at) {
      store.link(card.id, { branch: result.branch, repo: card.repo ? null : agent.repo, by: name });
    }
  };

const isStoryteller = (agent: LedgerAgent): boolean =>
  agent.kind === 'storyteller' || agent.role === 'storyteller';

/** The story a storyteller's outcome names: the first word of it (`<id>`, `fanout <id>: ...`) that is a story in the store. */
function storyNamed(home: string, outcome: string): string | null {
  const stories = new StoryStore({ home });
  return outcome.split(/[\s:,;]+/).find((word) => word && stories.dirOf(word)) ?? null;
}

/** A storyteller finishing (or parking its story for review) links the story its outcome names to its card; a card closed or missing is left alone. */
export function linkStory(home: string, agent: LedgerAgent, outcome?: string | null): void {
  if (!agent.card || !outcome || !isStoryteller(agent)) {
    return;
  }
  const story = storyNamed(home, outcome);
  const store = new BacklogStore(home);
  if (story && store.items().some((one) => one.id === agent.card)) {
    store.link(agent.card, { story, by: agent.name });
  }
}

export function finishRun(
  home: string,
  name: string,
  input: FinishInput = {},
  options: { mirror?: Mirror; warn?: (line: string) => void } = {},
): LedgerAgent {
  return runRegistry(home, options.mirror).finish(
    name,
    { ...input, beforeFinish: input.beforeFinish ?? teachCard(home, name, input.outcome) },
    options.warn,
  );
}
