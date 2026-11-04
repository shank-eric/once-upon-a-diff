/*
 * The route table: every call the bridge's HTTP API answers, with its method, its path, which keys may make it, the
 * body it takes and the answer it gives. The bridge registers its handlers from these entries, and the clients
 * (the extension, the board and the local page) call through them with the client in ./client.ts, so a route's path
 * and shapes are written once.
 *
 * Nothing here runs valibot. A body's type comes from its schema in ./schemas.ts through `import type`, which is
 * erased, so a page that imports this file never loads the schemas. Types only for the rest, and no DOM or Node.
 *
 * Pages and assets (GET /local/<id>/, GET /board/, /assets/*) are served, not called, so they are not here.
 */
import type { InferInput } from 'valibot';
import type * as schemas from './schemas.ts';
import type {
  Approval,
  BridgeStatus,
  BoardData,
  DraftsAnswer,
  FixesView,
  GithubRefreshAnswer,
  Freshness,
  Health,
  ListenSessions,
  ListenTyped,
  NoteAnswer,
  NoteUpdateAnswer,
  Ok,
  PanelUi,
  Prefs,
  PrPushAnswer,
  PrView,
  Pulse,
  PushAnswer,
  PushView,
  Question,
  QuestionMarksAnswer,
  ReadInfo,
  ReadMark,
  RebuildAnswer,
  StatusMany,
  StoryData,
  StoryList,
  ViewedAnswer,
  WorkingMark,
  WorktreeCleaned,
  BuildRequestView,
} from './types.ts';
import type { UsageAnswer } from './domain/usage-actions.ts';

/**
 * Which keys may make the call (the bridge's token always may):
 *  - `token`: the token only
 *  - `token+board`: and the agent board page's key
 *  - `token+page`: and the full key of a local story's page, for that story
 *  - `token+page+view`: and the story's read-only key too
 *  - `none`: no key, the route checks the request itself (POST /auth/session)
 * The bridge enforces this in server/index.ts and server/page-key.ts. A test compares the two, so a route can't be
 * added to one without the other.
 */
export type Keys = 'token' | 'token+board' | 'token+page' | 'token+page+view' | 'none';

/** One call. Body, answer, query and params are types only: the entry holds none of them. */
export interface Route<Body = undefined, Answer = unknown, Query = undefined, Params = undefined> {
  readonly method: 'GET' | 'POST';
  /** the full path, with `:name` where a value goes (a story's id, a note's id) */
  readonly path: string;
  /** a story route's name, the path segment after the story's id ('' for the story itself) */
  readonly what?: string;
  /** a story route's part after `what`, when it has a fixed one ('marks') or a value (':note') */
  readonly sub?: string;
  readonly keys: Keys;
  readonly types?: { body: Body; answer: Answer; query: Query; params: Params };
}

type Bodies = typeof schemas.BODIES;
/** The body a route takes, as a caller writes it (a schema's input). */
type In<Name extends keyof Bodies> = InferInput<Bodies[Name]>;

/** A bridge-wide route, /api/<path>. */
const api = <Body = undefined, Answer = unknown, Query = undefined>(
  method: 'GET' | 'POST',
  path: string,
  keys: Keys,
): Route<Body, Answer, Query> => ({ method, path, keys });

/** A story's route, /api/stories/<id>/<what>[/<sub>]. */
const story = <Body = undefined, Answer = unknown, Params = { id: string }>(
  method: 'GET' | 'POST',
  what: string,
  keys: Keys,
  sub?: string,
): Route<Body, Answer, undefined, Params> => ({
  method,
  path: `/api/stories/:id${what ? `/${what}` : ''}${sub ? `/${sub}` : ''}`,
  what,
  ...(sub ? { sub } : {}),
  keys,
});

/** The story panel's saved state, as GET and POST .../ui answer. */
export type SavedUi = Partial<PanelUi> & { hidden?: boolean; at?: string };

export const ROUTES = {
  // ---- bridge-wide, token only
  health: api<undefined, Health>('GET', '/api/health', 'token'),
  status: api<undefined, BridgeStatus, { story?: string; repo?: string }>(
    'GET',
    '/api/status',
    'token',
  ),
  prefsRead: api<undefined, Prefs>('GET', '/api/prefs', 'token'),
  prefsWrite: api<In<'prefs'>, Prefs>('POST', '/api/prefs', 'token'),
  stories: api<undefined, StoryList>('GET', '/api/stories', 'token'),
  statusMany: api<In<'statusMany'>, StatusMany>('POST', '/api/stories/status-many', 'token'),
  buildRequest: api<In<'buildRequest'>, { state: string; request: BuildRequestView }>(
    'POST',
    '/api/builds',
    'token',
  ),

  // a page's batch of UI action counts (domain/usage-actions.ts); the board's key and the extension's token reach it
  usageCount: api<In<'usage'>, UsageAnswer>('POST', '/api/usage', 'token+board'),

  githubRefresh: api<In<'githubRefresh'>, GithubRefreshAnswer>(
    'POST',
    '/api/github/refresh',
    'token',
  ),

  // ---- the agent board: the board page's key reaches these, except the link
  board: api<undefined, BoardData>('GET', '/api/board', 'token+board'),
  boardLink: api<undefined, { url: string }, { public?: '1' }>('GET', '/api/board/link', 'token'),
  boardType: api<In<'boardType'>, Ok & { typed: string }>('POST', '/api/board/type', 'token+board'),
  boardListenSessions: api<undefined, ListenSessions, { repo?: string; story?: string }>(
    'GET',
    '/api/board/listen-sessions',
    'token+board',
  ),
  boardVoicePause: api<In<'boardVoicePause'>, Ok & { paused: boolean }>(
    'POST',
    '/api/board/voice/pause',
    'token+board',
  ),
  boardVoiceStart: api<In<'boardVoiceStart'>, Ok & { voice: boolean }>(
    'POST',
    '/api/board/voice/start',
    'token+board',
  ),
  boardVoiceStop: api<undefined, Ok & { voice: boolean }>(
    'POST',
    '/api/board/voice/stop',
    'token+board',
  ),
  boardVoicePhone: api<In<'boardVoicePhone'>, Ok & { on: boolean; bridge: boolean }>(
    'POST',
    '/api/board/voice/phone',
    'token+board',
  ),
  boardVoiceBridgeStop: api<undefined, Ok & { on: boolean; bridge: boolean }>(
    'POST',
    '/api/board/voice/phone/bridge-stop',
    'token+board',
  ),
  boardStopListening: api<In<'boardStopListening'>, Ok>(
    'POST',
    '/api/board/stop-listening',
    'token+board',
  ),
  boardAgentFinish: api<In<'boardAgentFinish'>, Ok & { ledger: boolean }>(
    'POST',
    '/api/board/agent/finish',
    'token+board',
  ),
  boardFocus: api<In<'boardFocus'>, Ok>('POST', '/api/board/focus', 'token+board'),
  boardOpenStory: api<In<'boardOpenStory'>, { url: string }>(
    'POST',
    '/api/board/open-story',
    'token+board',
  ),
  boardReviewed: api<In<'boardReviewed'>, Ok>('POST', '/api/board/reviewed', 'token+board'),
  boardBacklogAdd: api<In<'boardBacklogAdd'>, Ok & { id: string }>(
    'POST',
    '/api/board/backlog',
    'token+board',
  ),
  boardBacklogMove: api<In<'boardBacklogMove'>, Ok>(
    'POST',
    '/api/board/backlog/move',
    'token+board',
  ),
  boardBacklogEdit: api<In<'boardBacklogEdit'>, Ok>(
    'POST',
    '/api/board/backlog/edit',
    'token+board',
  ),
  boardBacklogDrop: api<In<'boardBacklogDrop'>, Ok>(
    'POST',
    '/api/board/backlog/drop',
    'token+board',
  ),
  boardBacklogAssign: api<In<'boardBacklogAssign'>, Ok & { typed: string; session: string }>(
    'POST',
    '/api/board/backlog/assign',
    'token+board',
  ),
  boardWorktreeClean: api<In<'boardWorktreeClean'>, WorktreeCleaned>(
    'POST',
    '/api/board/worktree/clean',
    'token+board',
  ),

  // ---- a page on an allowed host name hands over the board's key for a cookie
  authSession: api<In<'authSession'>, { cookie: boolean }>('POST', '/auth/session', 'none'),

  // ---- a story: read-only key allowed ("view") where the page-key.ts list says so
  story: story<undefined, StoryData>('GET', '', 'token+page+view'),
  storyVersion: story<undefined, { version: string }>('GET', 'version', 'token+page+view'),
  storyPulse: story<undefined, Pulse>('GET', 'pulse', 'token+page+view'),
  storySeen: story<undefined, Ok>('POST', 'seen', 'token+page+view'),
  storyUiRead: story<undefined, SavedUi>('GET', 'ui', 'token+page+view'),
  storyUiWrite: story<In<'ui'>, SavedUi>('POST', 'ui', 'token+page+view'),
  storyPosition: story<In<'position'>, Ok>('POST', 'position', 'token+page+view'),
  storyFreshness: story<undefined, Freshness>('GET', 'freshness', 'token+page+view'),
  storyRebuildRead: story<undefined, RebuildAnswer>('GET', 'rebuild', 'token+page+view'),
  storyRebuildWrite: story<In<'rebuild'>, RebuildAnswer>('POST', 'rebuild', 'token+page+view'),
  storyStatus: story<undefined, BridgeStatus>('GET', 'status', 'token+page+view'),
  storyPrefsRead: story<undefined, Prefs>('GET', 'prefs', 'token+page+view'),
  storyPrefsWrite: story<In<'prefs'>, Prefs>('POST', 'prefs', 'token+page+view'),
  questionsRead: story<undefined, { questions: Question[] }>('GET', 'questions', 'token+page+view'),
  questionAsk: story<In<'questionAsk'>, Question>('POST', 'questions', 'token+page+view'),
  questionMarks: story<In<'questionMarks'>, QuestionMarksAnswer>(
    'POST',
    'questions',
    'token+page+view',
    'marks',
  ),
  draftsRead: story<undefined, DraftsAnswer>('GET', 'drafts', 'token+page+view'),
  draftsAct: story<In<'draftsAct'>, DraftsAnswer>('POST', 'drafts', 'token+page+view'),
  readRead: story<undefined, ReadInfo>('GET', 'read', 'token+page+view'),
  readNote: story<In<'readNote'>, ReadMark>('POST', 'read', 'token+page+view'),
  viewed: story<In<'viewed'>, ViewedAnswer>('POST', 'viewed', 'token+page+view'),
  noteAdd: story<In<'noteAdd'>, NoteAnswer>('POST', 'notes', 'token+page+view'),
  noteUpdate: story<In<'noteUpdate'>, NoteUpdateAnswer, { id: string; note: string }>(
    'POST',
    'notes',
    'token+page+view',
    ':note',
  ),
  fixesRead: story<undefined, FixesView>('GET', 'fixes', 'token+page+view'),
  fixesAct: story<In<'fixesAct'>, FixesView & { sent?: unknown }>(
    'POST',
    'fixes',
    'token+page+view',
  ),
  working: story<undefined, { marks?: WorkingMark[] }>('GET', 'working', 'token+page+view'),
  prView: story<undefined, PrView>('GET', 'pr', 'token+page+view'),
  storyUsageCount: story<In<'usage'>, UsageAnswer>('POST', 'usage', 'token+page+view'),

  // ---- a story: the full page key only (never the read-only one)
  storyListenSessions: story<undefined, ListenSessions>('GET', 'listen', 'token+page'),
  storyListen: story<In<'listen'>, ListenTyped>('POST', 'listen', 'token+page'),
  approve: story<In<'approve'>, Approval>('POST', 'approve', 'token+page'),
  prPush: story<In<'prPush'>, PrPushAnswer>('POST', 'pr', 'token+page'),
  pushView: story<undefined, PushView>('GET', 'push', 'token+page'),
  pushApproved: story<In<'pushApproved'>, PushAnswer>('POST', 'push', 'token+page'),
} as const;

/** The name of a route in ROUTES. */
export type RouteName = keyof typeof ROUTES;

/** Any route: a Route is read-only in its types, so each one fits. */
export type AnyRoute = Route<unknown, unknown, unknown, unknown>;

/** Whether the agent board page's key may make this call. */
export const boardKeyMay = (route: { keys: Keys }): boolean => route.keys === 'token+board';

/** Whether a local story's read-only key may make this call. */
export const viewKeyAllowed = (route: { keys: Keys }): boolean => route.keys === 'token+page+view';

/** What a route takes and gives, from the types it was written with. */
export type BodyOf<R extends AnyRoute> = NonNullable<R['types']>['body'];
export type AnswerOf<R extends AnyRoute> = NonNullable<R['types']>['answer'];
export type QueryOf<R extends AnyRoute> = NonNullable<R['types']>['query'];
export type ParamsOf<R extends AnyRoute> = NonNullable<R['types']>['params'];
