/** The worktrees section of the board: what the scanner has, each judged, on the card it belongs to or loose. */
import { statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_BRANCHES } from '../../config/settings.ts';
import { sameRepo, seenCheckouts } from '../../config/repos.ts';
import type { LedgerAgent } from '../../ledger/ledger.ts';
import type { LiveSession } from '../../../adapters/claude-sessions/live-sessions.ts';
import { judge, workingIn } from '../../worktrees/worktrees.ts';
import type { WorktreeFacts, WorktreeScanner } from '../../worktrees/worktrees.ts';
import type {
  BoardAgent,
  BoardCard,
  BoardSession,
  BoardWorktree,
  BoardWorktrees,
} from '@once-upon-a-diff/protocol/types';
import type { PrWatcher } from './pr-watcher.ts';

/** A path a task names as the folder it is in: itself when a folder, its folder when a file, null when it is not there. */
export function dirOf(candidate: string): string | null {
  try {
    return statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
  } catch {
    return null;
  }
}

/** What the worktrees are placed against. */
export interface WorktreeInput {
  scanner: WorktreeScanner;
  home: string;
  review: PrWatcher;
  /** the cards a worktree may be tied to: its worktrees go on `worktrees` of the card, which changes the card given */
  cards: BoardCard[];
  live: LiveSession[];
  sessionViews: Map<string, BoardSession>;
  agents: LedgerAgent[];
  keepBranches: string[];
  nowMs: number;
}

/**
 * The worktrees section: what the scanner has (it is kicked here and never waited for), each judged. A worktree tied to
 * a card (its branch, a session in it, or a started backlog item that lists it) goes on that card; the rest are returned.
 */
export function worktreeSection({
  scanner,
  home,
  review,
  cards,
  live,
  sessionViews,
  agents,
  keepBranches,
  nowMs,
}: WorktreeInput): BoardWorktrees {
  // where to look: the folders of live sessions and of registered agents (never the text of a task), and the checkouts seen
  const seeds = [
    ...live.map((session) => session.cwd),
    ...agents.map((agent) => agent.cwd ?? ''),
    ...seenCheckouts(home),
  ].filter(Boolean);
  scanner.kick(seeds);
  const scan = scanner.read();
  const sessions = live.map((session) => ({
    id: session.session,
    title: sessionViews.get(session.session)?.title ?? session.name ?? path.basename(session.cwd),
    cwd: session.cwd,
  }));
  const judged = scan.items.map((facts) =>
    judge(facts, {
      inUse: workingIn(facts.path, sessions, agents, facts),
      pr: prOfFacts(review, facts),
      keepBranches,
      now: nowMs,
    }),
  );
  const inside = (dir: string, parent: string) =>
    dir === parent || dir.startsWith(parent + path.sep);
  const loose: BoardWorktree[] = [];
  for (const tree of judged) {
    const card = cards.find(
      (one) =>
        (!!one.repo &&
          !!tree.repo &&
          !!tree.branch &&
          !DEFAULT_BRANCHES.has(tree.branch) &&
          sameRepo(one.repo, tree.repo) &&
          one.branch === tree.branch) ||
        one.sessions.some((session) => inside(session.cwd, tree.path)) ||
        one.agents.some((agent) => usedBy(tree, agent)) ||
        !!one.backlog?.started?.links?.worktrees.some((linked) => linked.path === tree.path),
    );
    if (card) {
      card.worktrees = [...(card.worktrees ?? []), tree];
    } else {
      loose.push(tree);
    }
  }
  loose.sort(
    (first, second) =>
      Number(second.removable) - Number(first.removable) ||
      first.lane.localeCompare(second.lane) ||
      String(first.last_commit_at).localeCompare(String(second.last_commit_at)),
  );
  return {
    at: scan.finished ? new Date(scan.finished).toISOString() : null,
    scanning: scan.scanning || scan.finished === null,
    total: judged.length,
    on_cards: judged.length - loose.length,
    // the header counts what the lane lists; a worktree on a card has its own Clean up on the card
    removable: loose.filter((tree) => tree.removable).length,
    size_kb: loose.reduce((sum, tree) => sum + (tree.size_kb ?? 0), 0),
    items: loose,
    prunable: scan.prunable,
  };
}

/** Whether a card's agent is one holding the worktree: the holder's id is its key, `<sid8>:<name>`, which a card's agent carries. */
function usedBy(tree: BoardWorktree, agent: BoardAgent): boolean {
  return tree.in_use.some((using) => using.kind === 'agent' && using.id === agent.key);
}

/** What GitHub last said of the worktree's branch (asked in the background for a branch not yet in live or main). */
export function prOfFacts(review: PrWatcher, facts: WorktreeFacts): BoardWorktree['pr'] {
  if (!facts.repo || !facts.branch || facts.merged || facts.superseded) {
    return { number: null, state: 'unknown' };
  }
  review.kickBranch(facts.repo, facts.branch, facts.path);
  const found = review.branchPr(facts.repo, facts.branch);
  if (found === undefined) {
    return { number: null, state: 'unknown' };
  }
  return found ? { number: found.number, state: found.state } : { number: null, state: 'none' };
}
