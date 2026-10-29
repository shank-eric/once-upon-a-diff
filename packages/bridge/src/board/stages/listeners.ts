/**
 * Listeners: a story's own listener marks its card with the session that listens; repos get the Listeners lane. A
 * session can be typed into (Build story, Start listening) when it is at its prompt: not working, not waiting on you.
 */
import type { Listener } from '../../listeners/listeners.ts';
import { buildFor, sessionOfPid, storyListening } from '../listening.ts';
import type { ListeningInput } from '../listening.ts';
import type { BoardCard, BoardSession } from '@once-upon-a-diff/shared/types';
import type { BuildContext, PinnedVoice } from './types.ts';

/** What the listening rules need to know of the sessions. */
export interface ListenerFacts {
  /** the live listeners (each a running `once-upon wait`), the process parents `ps` knows, and which session each pid is */
  waits: Listener[];
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** the sessions that are on no card of the columns: those that only listen, the voice session, the blank ones */
  quietViews: BoardSession[];
  blankViews: { lane: string; view: BoardSession }[];
  pin: PinnedVoice | null;
  repoBySession: Map<string, string | null>;
}

/**
 * Marks each story card with the session that listens for it (`listening`), and each card with the session that could
 * build its story (`build`): both are set on the cards given. The answer is every session by id, and the input the
 * listening rules (Start listening, Assign, the Listeners lane) are applied with.
 */
export function markListening(
  ctx: BuildContext,
  cards: BoardCard[],
  { waits, parents, sessionByPid, quietViews, blankViews, pin, repoBySession }: ListenerFacts,
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
    apart,
  };
  for (const card of cards) {
    if (card.story) {
      card.listening = storyListening(card.story.id, waits, listening);
    }
    if (card.column !== 'done' && card.column !== 'ship') {
      card.build = buildFor(card, idle);
    }
  }
  return { listening, sessionViews };
}
