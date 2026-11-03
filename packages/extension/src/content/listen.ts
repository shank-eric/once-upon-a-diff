/*
 * Start listening on GitHub pages (the panel, and the notice on PR lists and a PR's Conversation tab), through the service
 * worker to the bridge's board routes (the same ones the board page's Start listening uses): which idle Claude Code sessions
 * may be typed into, and typing the listen line into one. The bridge makes the line and checks the session again, so
 * nothing the page sends is text to type.
 */
import { bridgeProblem } from '@once-upon-a-diff/api-client/client';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import type { Bridge, BridgeAnswer } from './bridge.ts';
import type { PanelOptions } from '@once-upon-a-diff/panel/overlay';
import type { ListenTarget } from '@once-upon-a-diff/protocol/types';

type Call = Bridge['call'];

/** Why a call failed, in words the panel can show after "Couldn't start it:". */
export function listenError(answer: Extract<BridgeAnswer, { ok: false }>): string {
  const error = String(answer.error || `HTTP ${answer.status}`);
  if (error === 'unreachable') {
    return 'the bridge is not running';
  }
  if (error === 'extension reloaded') {
    return 'the extension was reloaded, so reload this page';
  }
  if (error === 'not-configured' || answer.status === 401) {
    return 'the extension has no working bridge token (see its options)';
  }
  if (bridgeProblem(answer) === 'old') {
    return 'the bridge is older than this panel, so restart it (once-upon serve)';
  }
  return error;
}

/**
 * opts.listen for the story with this id, or for a page with no story (the notice on a PR list, which only starts a repo's
 * listener). `call` is the bridge client's call (a test passes its own).
 */
export function createListenOption(
  call: Call,
  storyId: string | null = null,
): NonNullable<PanelOptions['listen']> {
  /** The story's id for a story target; a page with no story has none, so it can only ask for a repo. */
  const storyOf = (): string => {
    if (!storyId) {
      throw new Error('this page has no story to listen for');
    }
    return storyId;
  };
  return {
    sessions: async (target: ListenTarget) => {
      const answer = await call(ROUTES.boardListenSessions, {
        query: target.scope === 'story' ? { story: storyOf() } : { repo: target.repo },
      });
      if (!answer.ok) {
        throw new Error(listenError(answer));
      }
      return answer.body.sessions;
    },
    start: async (sessionId: string, target: ListenTarget) => {
      const answer = await call(ROUTES.boardType, {
        body: {
          kind: 'listen',
          session: sessionId,
          ...(target.scope === 'story' ? { story: storyOf() } : { repo: target.repo }),
        },
      });
      if (!answer.ok) {
        throw new Error(listenError(answer));
      }
    },
  };
}
