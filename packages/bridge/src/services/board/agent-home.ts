/**
 * Where a registered agent goes on the board, decided only by the fields it registered (`once-upon agent start`:
 * repo, branch, PR, card, and the branch and PR its finish event reports), never by its task, name or outcome. An
 * agent with a home is nested inside that card; every other agent, including one read from the old ledger text, which
 * has none of those fields, is a card of its own (stages/agents.ts). An agent that claimed a backlog card is neither:
 * it is shown on that card (claims.ts).
 */
import type { BoardCard } from '@once-upon-a-diff/protocol/types';
import { sameRepo } from '../config/repos.ts';
import type { BacklogItem } from '../backlog/backlog.ts';
import { cardOnBranch } from '../backlog/backlog.ts';
import { isReviewer, type LedgerAgent } from '../ledger/ledger.ts';

/**
 * The card an agent works on, or null: the one card that its registered fields point to. Three ways to point, each exact
 * (no text, no loose compare), and the agent has a home only when they all name the same card:
 *
 *   branch   its repo and branch (the finish event's branch when it has one): the branch's work card, else a session on it
 *   PR       its repo and PR number (the finish event's PR when it has one): that work card
 *   card     its backlog card (`--card`): the work or session card on that item's repo and branch, if the item has a branch.
 *            This needs no repo of the agent's own: the item supplies it
 *
 * Two different cards named, or none, is no home.
 */
export function homeOf(
  agent: Pick<LedgerAgent, 'repo' | 'branch' | 'pr' | 'card' | 'result'>,
  cards: BoardCard[],
  items: Pick<BacklogItem, 'id' | 'repo' | 'branch'>[],
): BoardCard | null {
  const repo = agent.repo ?? null;
  const branch = agent.result?.branch ?? agent.branch ?? null;
  const pr = agent.result?.pr ?? agent.pr ?? null;
  const found = new Set<BoardCard>();
  const add = (card: BoardCard | undefined) => {
    if (card) {
      found.add(card);
    }
  };
  if (repo && branch) {
    add(cardOnBranch({ repo, branch }, cards));
  }
  if (repo && pr) {
    add(
      cards.find(
        (card) => card.kind === 'work' && sameRepo(card.repo, repo) && card.pr?.number === pr,
      ),
    );
  }
  const item = agent.card ? items.find((one) => one.id === agent.card) : undefined;
  if (item?.branch) {
    add(cardOnBranch(item, cards));
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Whether a finished agent made something you can point at, and so is Done, not Waiting. No text is read: not the
 * outcome, not the task. Made something is any of: a reviewer (its findings are in the story and the review file, so
 * off the board once it is finished); a registered agent whose finish event has a result (a commit, PR, branch or card:
 * given with --commit, --pr, --branch or --card, or recorded from the registered branch moving, registry.ts); or an
 * agent known only from a ledger `[done]` line, which carries no result, so its own word that it is done is all there
 * is. A registered agent with no result (research, or a builder that made nothing) is Waiting, and so is a stopped
 * one (registered or ledger-only). A failed one is Waiting whatever this says (stages/agents.ts).
 */
export function madeSomething(
  agent: Pick<LedgerAgent, 'name' | 'state'> &
    Partial<Pick<LedgerAgent, 'source' | 'kind' | 'result'>>,
): boolean {
  if (isReviewer(agent)) {
    return true;
  }
  if (agent.source === 'events') {
    // a run that was stopped made nothing to point at, whatever it recorded
    return agent.state !== 'stopped' && !!agent.result && Object.keys(agent.result).length > 0;
  }
  return agent.state === 'done';
}
