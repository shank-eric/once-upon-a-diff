/**
 * Where a ledger agent goes on the board. By default it is a card of its own, on its own lane: its `lane:<name>` tag,
 * else the repo it worked in when its task text says (a worktree path, or a lane name), else its parent's lane. It is
 * nested inside its parent's card only when it is tightly tied to it, which is what `tiedToParent` decides, the one
 * place for that rule.
 */
import type { BoardCard } from '@once-upon-a-diff/shared/types';
import type { LedgerAgent } from './ledger.ts';

/** Lowercase letters and digits only, so "Once Upon a Diff" and "once-upon-a-diff" compare equal. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether the agent is working on the same branch or PR as its parent's card, so it belongs inside it: the card is a
 * branch or PR (not a session alone), the agent has no lane tag that names another lane, and its task says the card's
 * branch or PR number. An agent that says neither is not tied, so it gets its own card.
 */
export function tiedToParent(agent: LedgerAgent, card: BoardCard): boolean {
  if (card.kind !== 'work') {
    return false;
  }
  if (agent.lane && agent.lane.toLowerCase() !== card.lane.toLowerCase()) {
    return false;
  }
  const task = `${agent.name} ${agent.task || ''}`;
  if (card.branch && task.toLowerCase().includes(card.branch.toLowerCase())) {
    return true;
  }
  const number = card.pr?.number;
  return !!number && new RegExp(`(?:#|\\bPR |/pull/)${number}\\b`, 'i').test(task);
}

/**
 * The lane for an agent with its own card: its tag, else the known lane (a repo or tag already on the board) its task
 * text names (a `<repo>-worktrees/` path, or the lane's name, which "Once Upon a Diff" matches for once-upon-a-diff),
 * else its parent's lane, else "No live session".
 */
export function laneForAgent(
  agent: LedgerAgent,
  knownLanes: string[],
  parentLane: string | null,
  fallback: string,
): string {
  if (agent.lane) {
    return agent.lane;
  }
  const task = agent.task || '';
  const worktree = /([\w.-]+)-worktrees\//.exec(task)?.[1];
  const byWorktree = worktree && knownLanes.find((lane) => squash(lane) === squash(worktree));
  if (byWorktree) {
    return byWorktree;
  }
  const text = squash(task);
  const named = [...knownLanes]
    .sort((first, second) => second.length - first.length)
    .find((lane) => {
      const flat = squash(lane);
      // a short name (SDK) has to stand as a word of its own, a longer one can be written with other spacing
      return flat.length >= 5
        ? text.includes(flat)
        : new RegExp(`\\b${lane.replace(/\W/g, '')}\\b`, 'i').test(task);
    });
  return named || parentLane || fallback;
}
