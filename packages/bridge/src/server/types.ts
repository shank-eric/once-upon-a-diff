/*
 * The HTTP app's request plumbing the routes share: what every route gets (`App`, the stores and settings), one call, and
 * a route's shape. Types only.
 */
import type { IncomingMessage } from 'node:http';
import type { AnyRoute } from '@once-upon-a-diff/protocol/routes';
import type { StoryStore } from '../services/stories/store.ts';
import type { Inbox } from '../services/inbox/inbox.ts';
import type { Build, Builds } from '../services/inbox/builds.ts';
import type { AutoReview } from '../services/review/auto-review.ts';
import type { Board } from '../services/board/board.ts';
import type { Sessions } from '../services/sessions/sessions.ts';
import type { ServedStory } from '../services/stories/types.ts';

/** A JSON request body: whatever the page sent, for the route to check. */
export type Body = Record<string, unknown>;

/** Answers a request: JSON for application/json, else the body as is. */
export type Send = (
  status: number,
  body: unknown,
  type?: string,
  extra?: Record<string, string>,
) => void;

/** The bridge's stores and settings, which every route gets. */
export interface App {
  home: string;
  version: string;
  stories: StoryStore;
  inbox: Inbox;
  builds: Builds;
  /** the agent board's data */
  board: Board;
  /** the sessions a click may type into: Build story, Start listening, focus (board.sessions) */
  sessions: Sessions;
  /** marks PR stories reviewed when GitHub says you have */
  autoReview: AutoReview;
  /** page links with their keys: a local story's page and the agent board's */
  links: {
    /** a local story's page link; the full key (it can push), or with `readOnly` the one that reads but never pushes */
    story(id: string, readOnly?: boolean): string;
    board(origin?: string): string;
  };
  log: (line: string) => void;
  /** PR-list lookups, kept 5s */
  statusCache: {
    at: number;
    list: ReturnType<StoryStore['list']>;
    builds: Record<string, Build>;
  } | null;
  /** the last time the extension talked to the bridge */
  extensionSeen: { at: string; origin: string } | null;
}

/** One API call. */
export interface Call {
  app: App;
  req: IncomingMessage;
  url: URL;
  body: Body;
  send: Send;
  /** which page's key (not the bridge's token) made the call, when one did */
  pageScope?: 'board' | null;
  /** a story's read-only key made the call (page-key.ts viewKey): it never reaches the PR routes */
  readOnly?: boolean;
}

/** An /api/<path> route: its entry in the protocol's table (path, method, keys) and what answers it. */
export interface ApiRoute {
  route: AnyRoute;
  handle(call: Call): unknown;
}

/** A /api/stories/<id>/<what>[/<sub>] route: its entry in the protocol's table and what answers it. */
export interface StoryRoute {
  route: AnyRoute;
  handle(call: Call, story: ServedStory): unknown;
}
