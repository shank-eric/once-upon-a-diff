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
 * The column of a finished agent that is not inside a card. No text is read: not the outcome, not the task, only what it
 * registered. In order:
 *
 *   failed                                    Waiting: it needs a look (stages/agents.ts)
 *   a reviewer                                Done: its findings are in the story and the review file
 *   registered, finished with a result        Done: a commit, PR, branch or card (given with --commit, --pr, --branch or
 *                                             --card, or recorded from the registered branch moving, registry.ts). A
 *                                             stopped run made nothing to point at, whatever it recorded
 *   registered, no result, kind research      Research: done or stopped, it asks nothing and lost nothing
 *   registered, done, no result, kind helper  Done: a deploy, plan check or lookup did its job and asks nothing (a standing
 *                                             helper has no card at all, stages/helpers.ts; a plain one does)
 *   registered, no result, kind builder       Waiting: an author that made nothing is a miss to look at
 *   registered, no result, no kind            Waiting, as before kinds existed: not known to be research or a helper
 *   registered, stopped, any kind but research  Waiting: interrupted work, a decision
 *   known only from the ledger                Done on a `[done]` line, Waiting on `[stopped]`: it has no kind or result,
 *                                             so it is never Research
 */
export function finishedColumn(
  agent: Pick<LedgerAgent, 'name' | 'state'> &
    Partial<Pick<LedgerAgent, 'source' | 'kind' | 'result'>>,
): 'done' | 'research' | 'waiting' {
  if (agent.state === 'failed') {
    return 'waiting';
  }
  if (isReviewer(agent)) {
    return 'done';
  }
  if (agent.source !== 'events') {
    return agent.state === 'done' ? 'done' : 'waiting';
  }
  if (agent.state !== 'stopped' && agent.result && Object.keys(agent.result).length > 0) {
    return 'done';
  }
  if (agent.kind === 'research') {
    return 'research';
  }
  // a helper (or an editor) that finished its job with nothing to point at is done; only an author's miss, a stopped run
  // and a failure are for you to look at
  return agent.state === 'done' && agent.kind && agent.kind !== 'builder' ? 'done' : 'waiting';
}
