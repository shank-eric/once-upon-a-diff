/*
 * The routes the extension calls, and so the only ones its service worker forwards with the bridge's token. Content
 * scripts run on github.com, so a call the extension never makes has no reason to get the token. A test checks this
 * list against the routes the extension's code names (test/bridge-routes.test.ts): add a route here when the code
 * starts calling it.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';

export const EXTENSION_ROUTES = [
  ROUTES.boardLink,
  ROUTES.boardListenSessions,
  ROUTES.boardType,
  ROUTES.buildRequest,
  ROUTES.draftsAct,
  ROUTES.draftsRead,
  ROUTES.fixesAct,
  ROUTES.fixesRead,
  ROUTES.githubRefresh,
  ROUTES.health,
  ROUTES.noteUpdate,
  ROUTES.prefsRead,
  ROUTES.prefsWrite,
  ROUTES.questionAsk,
  ROUTES.questionMarks,
  ROUTES.questionsRead,
  ROUTES.readNote,
  ROUTES.readRead,
  ROUTES.status,
  ROUTES.statusMany,
  ROUTES.stories,
  ROUTES.story,
  ROUTES.storyFreshness,
  ROUTES.storyPosition,
  ROUTES.storyPulse,
  ROUTES.storyRebuildWrite,
  ROUTES.storySeen,
  ROUTES.storyVersion,
  ROUTES.working,
] as const;
