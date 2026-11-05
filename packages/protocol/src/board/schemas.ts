/*
 * The agent board's request bodies, and the cookie handover (POST /auth/session). Server side only: it imports
 * valibot, so the bridge never serves this file to a page.
 */
import {
  boolean,
  check,
  nullable,
  object,
  optional,
  picklist,
  pipe,
  regex,
  string,
  type GenericSchema,
} from 'valibot';
import { sessionId, names } from '../schema-kit.ts';
import { BACKLOG_ID_RE } from '@once-upon-a-diff/domain/patterns';

const MOVE_NEEDS = 'before (an item id) or edge (top or bottom) is needed';

export const BOARD_BODIES = {
  /** POST /auth/session */
  authSession: object({ key: optional(string(), '') }),
  /** POST /api/board/type */
  boardType: object({
    kind: picklist(['build', 'listen']),
    session: sessionId,
    repo: optional(nullable(string())),
    story: optional(nullable(string())),
    /** Build story's card: its own prompt is typed, not another card's built for the same session */
    card: optional(nullable(string())),
  }),
  boardVoicePause: object({ paused: boolean() }),
  boardVoicePhone: object({ on: boolean() }),
  boardVoiceStart: object({ session: optional(sessionId) }),
  boardStopListening: object({ repo: optional(string(), '') }),
  boardFocus: object({ session: sessionId }),
  boardOpenStory: object({ story: optional(string(), '') }),
  boardReview: object({ card: optional(string(), '') }),
  boardReviewed: object({ story: optional(string(), ''), reviewed: optional(boolean()) }),
  boardBacklogAdd: object({
    title: optional(string(), ''),
    note: optional(nullable(string())),
    repo: optional(nullable(string())),
  }),
  boardBacklogMove: pipe(
    object({
      id: optional(string(), ''),
      before: optional(string()),
      edge: optional(picklist(['top', 'bottom'])),
    }),
    check((body) => !!body.before || !!body.edge, MOVE_NEEDS),
  ),
  boardBacklogEdit: object({
    id: pipe(string(), regex(BACKLOG_ID_RE)),
    title: optional(string()),
    note: optional(nullable(string())),
    repo: optional(nullable(string())),
  }),
  boardBacklogDrop: object({ id: optional(string(), '') }),
  boardBacklogSomeday: object({ id: pipe(string(), regex(BACKLOG_ID_RE)), on: boolean() }),
  boardBacklogAssign: object({ id: pipe(string(), regex(BACKLOG_ID_RE)) }),
  boardAgentFinish: object({
    sid: pipe(string(), regex(/^[0-9a-f]{8}$/)),
    name: pipe(string(), regex(/^[\w.-]+$/)),
  }),
  boardWorktreeClean: object({
    path: optional(string(), ''),
    ack: names,
    ignored: names,
  }),
} satisfies Record<string, GenericSchema>;

/** What the bridge has always said about a field of these bodies, where a page shows it. */
export const BOARD_MESSAGES: Partial<Record<keyof typeof BOARD_BODIES, Record<string, string>>> = {
  boardType: {
    kind: 'a kind (build or listen) and a session id are needed',
    session: 'a kind (build or listen) and a session id are needed',
  },
  boardVoicePause: { paused: 'paused (true or false) is needed' },
  boardVoicePhone: { on: 'on (true or false) is needed' },
  boardVoiceStart: { session: 'session must be a session id' },
  boardFocus: { session: 'a session id is needed' },
  boardBacklogMove: { edge: MOVE_NEEDS },
  boardBacklogAssign: { id: 'a backlog item id is needed' },
  boardBacklogEdit: { id: 'a backlog item id is needed' },
  boardBacklogSomeday: {
    id: 'a backlog item id is needed',
    on: 'on (true or false) is needed',
  },
};
