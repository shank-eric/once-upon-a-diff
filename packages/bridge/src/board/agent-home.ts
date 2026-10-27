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
 * Whether the text names the branch as a whole token: bounded by the start or end, whitespace, or punctuation other
 * than `/`, `-`, `_` and `.`, so a branch `ui` is not found inside "build" or "ui-kit", and `feat/x` not in `feat/x-2`.
 * A `.` ends a token only as the end of a sentence (followed by whitespace or the end).
 */
export function namesBranch(text: string, branch: string): boolean {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w/.-])${escaped}(?![\\w/-]|\\.\\w)`, 'i').test(text);
}

/** Whether the agent's task names the card's branch (as a whole token, see `namesBranch`), or its PR by number (#7, PR 7 or /pull/7). */
function namesCard(agent: LedgerAgent, card: BoardCard): boolean {
  const task = `${agent.name} ${agent.task || ''}`;
  if (card.branch && namesBranch(task, card.branch)) {
    return true;
  }
  const number = card.pr?.number;
  return !!number && new RegExp(`(?:#|\\bPR |/pull/)${number}\\b`, 'i').test(task);
}

/**
 * Whether the agent is working on the same branch or PR as its parent's card, so it belongs inside it: the card is a
 * branch or PR (not a session alone), the agent has no lane tag that names another lane, and its task says the card's
 * branch (as a whole token, see `namesBranch`) or PR number. An agent that says neither is not tied, so it gets its own card.
 */
export function tiedToParent(agent: LedgerAgent, card: BoardCard): boolean {
  if (card.kind !== 'work') {
    return false;
  }
  if (agent.lane && agent.lane.toLowerCase() !== card.lane.toLowerCase()) {
    return false;
  }
  return namesCard(agent, card);
}

/** Whether a lane tag and a lane name are the same lane, loosely: "once-upon" is the lane "once-upon-a-diff". */
function sameLane(tag: string, lane: string): boolean {
  const first = squash(tag);
  const second = squash(lane);
  return !!first && !!second && (first.startsWith(second) || second.startsWith(first));
}

/**
 * The branch or PR card a gated agent (a plan to check, a reviewer, findings being fixed) belongs in, wherever its
 * launching session is: the work card whose branch or PR its task names, in a lane its tag matches loosely. Only one
 * match counts. When several cards fit (the same branch name in two repos), the one on the parent's lane wins, else none.
 */
export function gatedHome(
  agent: LedgerAgent,
  cards: BoardCard[],
  parentLane: string | null,
): BoardCard | null {
  const fits = cards.filter(
    (card) =>
      card.kind === 'work' &&
      (!agent.lane || sameLane(agent.lane, card.lane)) &&
      namesCard(agent, card),
  );
  if (fits.length <= 1) {
    return fits[0] ?? null;
  }
  const near = fits.filter(
    (card) => parentLane && card.lane.toLowerCase() === parentLane.toLowerCase(),
  );
  return near.length === 1 ? near[0] : null;
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
  const byWorktree =
    squash(worktree || '') && knownLanes.find((lane) => squash(lane) === squash(worktree || ''));
  if (byWorktree) {
    return byWorktree;
  }
  const text = squash(task);
  const named = [...knownLanes]
    .sort((first, second) => second.length - first.length)
    .find((lane) => {
      const flat = squash(lane);
      // a name with no letters or digits (a cwd of /, a lane tag of --) is nothing to look for: it would match every task
      if (!flat) {
        return false;
      }
      // a short name (SDK) has to stand as a word of its own, a longer one can be written with other spacing
      return flat.length >= 5
        ? text.includes(flat)
        : new RegExp(`\\b${lane.replace(/\W/g, '')}\\b`, 'i').test(task);
    });
  return named || parentLane || fallback;
}
