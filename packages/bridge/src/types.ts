/*
 * The bridge's own records: what a story folder says it is (meta.json), and
 * the server's request plumbing the routes share. The story and the answers
 * the panel takes are in @once-upon-a-diff/shared/types. Types only.
 */
import type { IncomingMessage } from 'node:http';
import type { LocalCommit } from '@once-upon-a-diff/shared/types';
import type { StoryStore } from './stories/store.ts';
import type { Inbox } from './inbox/inbox.ts';
import type { Build, Builds } from './inbox/builds.ts';
import type { AutoReview } from './review-inbox/auto-review.ts';
import type { Board } from './board/board.ts';
import type { Config } from './config/settings.ts';

/** A story folder's meta.json (readMeta fills in kind, title and a PR's url). */
export interface StoryMeta {
  kind: 'github' | 'local';
  title?: string;
  // a PR story
  repo?: string | null;
  number?: number | null;
  url?: string | null;
  pr_title?: string;
  /** the PR author's login, from pr.json when the story was published */
  pr_author?: string | null;
  head_oid?: string | null;
  head_ref?: string | null;
  /** the once-upon folder it was published from */
  source?: string | null;
  // a local story
  repo_path?: string;
  base?: string;
  head?: string;
  base_oid?: string | null;
  branch?: string | null;
  commits?: LocalCommit[];
  /** when the story was told (`once-upon local`, a rebuild), not when its diff was last refreshed (`updated_at`) */
  built_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** A local story's meta.json: the checkout and the range it diffs. */
export type LocalMeta = StoryMeta & {
  kind: 'local';
  repo_path: string;
  base: string;
  head: string;
};

/** What inbox entries say about a story, with the repo for `wait --repo`. */
export interface StoryRef {
  story: string;
  kind: StoryMeta['kind'];
  title: string | undefined;
  repo: string | null;
}

/** The story a /api/stories/<id>/... call is about. sub is the path's last part, when there is one. */
export interface ServedStory {
  id: string;
  dir: string;
  meta: StoryMeta;
  ref: StoryRef;
  sub?: string;
}

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

/** An /api/<path> route. A route with a method answers only that method. */
export interface ApiRoute {
  path: string;
  method?: 'GET' | 'POST';
  what?: string;
  /** the agent board page's key may call this route too */
  boardKey?: boolean;
  handle(call: Call): unknown;
}

/** A /api/stories/<id>/<what>[/<sub>] route. */
export interface StoryRoute {
  what: string;
  method?: 'GET' | 'POST';
  handle(call: Call, story: ServedStory): unknown;
}

/** The parsed command line: a value per flag (true for a bare flag), and the bare words in `_`. */
export interface CliOpts {
  _?: string[];
  [flag: string]: string | true | string[] | undefined;
}

/** One of the CLI's commands: its help lines and what it does. */
export interface Command {
  name: string;
  usage: string[];
  run(home: string, cfg: Config, opts: CliOpts): unknown;
}
