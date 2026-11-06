/*
 * The agent board's calls: the board and its actions (the board page's key reaches these, except the link), and the
 * cookie handover. Nothing here runs valibot: a body's type comes from the schemas by `import type`, which is erased.
 */
import { api, type In } from '../route-kit.ts';
import type { ListenSessions, Ok } from '../bridge/types.ts';
import type { BoardData, WorktreeCleaned } from './types.ts';

export const BOARD_ROUTES = {
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
  boardReview: api<In<'boardReview'>, { url: string; story: string }>(
    'POST',
    '/api/board/review',
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
  boardBacklogEdit: api<In<'boardBacklogEdit'>, Ok & { warnings?: string[] }>(
    'POST',
    '/api/board/backlog/edit',
    'token+board',
  ),
  boardBacklogDrop: api<In<'boardBacklogDrop'>, Ok>(
    'POST',
    '/api/board/backlog/drop',
    'token+board',
  ),
  boardBacklogSomeday: api<In<'boardBacklogSomeday'>, Ok>(
    'POST',
    '/api/board/backlog/someday',
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
  authSession: api<In<'authSession'>, { cookie: boolean }>('POST', '/auth/session', 'none'),
} as const;
