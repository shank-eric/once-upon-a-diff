/**
 * Listeners: a story's own listener marks its card with the session that listens; repos get the Listeners lane. A
 * session can be typed into (Build story, Start listening) when it is at its prompt: not working, not waiting on you.
 */
import type { Listener } from '../../listeners/listeners.ts';
import { buildFor, reviewFor, sessionOfPid, storyListening } from '../../sessions/listening.ts';
import type { ListeningInput } from '../../sessions/listening.ts';
import type { BoardCard, BoardSession } from '@once-upon-a-diff/protocol/types';
import type { BuildContext, PinnedVoice } from './types.ts';
import type { WorktreeFacts } from '../../worktrees/worktrees.ts';
import { sameRepo } from '../../config/repos.ts';

/** What the listening rules need to know of the sessions. */
export interface ListenerFacts {
  /** the live listeners (each a running `once-upon wait`), the process parents `ps` knows, and which session each pid is */
  waits: Listener[];
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** the sessions that are on no card of the columns: those that only listen, the voice session, the blank ones */
  quietViews: BoardSession[];
  /** those of them that are busy (a turn, a request in hand, other tasks) */
  busyListeners: Set<string>;
  blankViews: { lane: string; view: BoardSession }[];
  pin: PinnedVoice | null;
  repoBySession: Map<string, string | null>;
  /** what the worktree scanner has (memory only): a branch it says is merged or superseded gets no Review */
  trees?: WorktreeFacts[];
}

/**
 * Whether a branch's work already shipped, from what is already known (no new git or gh call): GitHub said its PR
 * merged, or a worktree on it is merged or superseded (a squash or rebase merge shows as superseded).
 */
function shippedBy(ctx: BuildContext, trees: WorktreeFacts[]) {
  return (repo: string, branch: string): boolean =>
    ctx.review.branchPr(repo, branch)?.state === 'merged' ||
    trees.some(
      (tree) =>
        !!tree.repo &&
        sameRepo(tree.repo, repo) &&
        tree.branch === branch &&
        (tree.merged === true || tree.superseded === true),
    );
}

/**
 * Marks each story card with the session that listens for it (`listening`), and each card with the session that could
 * build its story (`build`): both are set on the cards given. The answer is every session by id, and the input the
 * listening rules (Start listening, Assign, the Listeners lane) are applied with.
 */
export function markListening(
  ctx: BuildContext,
  cards: BoardCard[],
  {
    waits,
    parents,
    sessionByPid,
    quietViews,
    busyListeners,
    blankViews,
    pin,
    repoBySession,
    trees = [],
  }: ListenerFacts,
): { listening: ListeningInput; sessionViews: Map<string, BoardSession> } {
  const sessionViews = new Map<string, BoardSession>();
  quietViews.forEach((view) => sessionViews.set(view.id, view));
  for (const card of cards) {
    card.sessions.forEach((view) => sessionViews.set(view.id, view));
  }
  if (pin) {
    sessionViews.set(pin.view.id, pin.view);
  }
  blankViews.forEach((item) => sessionViews.set(item.view.id, item.view));
  const idle = new Set(
    [...sessionViews.values()]
      .filter((view) => view.status === 'idle' || view.status === 'done')
      .map((view) => view.id),
  );
  // who may not take a new job (Start listening, Assign): the voice session and any session that already listens
  const apart = new Set<string>([
    ...(pin ? [pin.view.id] : []),
    ...quietViews.map((view) => view.id),
    ...waits
      .map((wait) => sessionOfPid(wait.pid, parents, sessionByPid))
      .filter((id): id is string => !!id),
  ]);
  const listening = {
    home: ctx.home,
    now: ctx.nowMs,
    parents,
    sessionByPid,
    sessions: sessionViews,
    repoOf: repoBySession,
    idle,
    busy: busyListeners,
    apart,
  };
  const shipped = shippedBy(ctx, trees);
  for (const card of cards) {
    if (card.story) {
      card.listening = storyListening(card.story.id, waits, listening);
    }
    if (card.column !== 'done' && card.column !== 'ship') {
      card.build = buildFor(card, idle);
      if (card.kind !== 'agent') {
        const review = reviewFor(card, shipped);
        if (review) {
          card.review = review;
        } else {
          delete card.review;
        }
      }
    }
  }
  return { listening, sessionViews };
}
