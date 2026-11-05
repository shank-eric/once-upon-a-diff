/*
 * A story's request bodies: the panel's saved state, position, rebuild, listen, questions, drafts, reads, notes,
 * fixes, approval and shipping. Server side only: it imports valibot, so the bridge never serves this file to a page.
 */
import {
  boolean,
  check,
  fallback,
  literal,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  string,
  transform,
  union,
  unknown,
  type GenericSchema,
} from 'valibot';
import { clipped, toWhole, whole, flag, sessionId, ids } from '../schema-kit.ts';

const QUESTION_ACTIONS = ['dismiss', 'restore', 'collapse', 'expand', 'read', 'unread'] as const;

export const STORY_BODIES = {
  /** POST .../ui: the panel's saved state */
  ui: object({
    n: optional(
      pipe(
        nullable(union([number(), string()])),
        transform((value) => toWhole(value) ?? 0),
      ),
      0,
    ),
    all: flag,
    collapsed: flag,
    width: whole,
    hidden: flag,
    filesOpen: flag,
    chatOpen: flag,
    chatHeight: whole,
  }),
  /** POST .../position */
  position: object({
    step: whole,
    chapter: clipped(300),
    file: clipped(1000),
    url: clipped(2000),
  }),
  /** POST .../seen: nothing in it */
  seen: object({}),
  /** POST .../rebuild */
  rebuild: object({
    mode: picklist(['rebuild', 'rebuild_from']),
    from_step: whole,
    guidance: clipped(4000),
    requested_at: optional(string()),
  }),
  /** POST .../listen */
  listen: object({
    session: sessionId,
    scope: optional(fallback(picklist(['repo', 'story']), 'repo')),
  }),
  /** POST .../questions: a new question */
  questionAsk: object({
    text: pipe(
      string(),
      transform((value) => value.slice(0, 8000)),
    ),
    step: whole,
    chapter: clipped(300),
    file: clipped(1000),
    url: clipped(2000),
  }),
  /** POST .../questions/marks */
  questionMarks: object({
    action: picklist(['clear', 'read_all', ...QUESTION_ACTIONS]),
    ids: optional(fallback(ids, []), []),
    seen: optional(
      fallback(
        nullable(
          pipe(
            unknown(),
            check((value) => !Array.isArray(value)),
            record(string(), string()),
          ),
        ),
        null,
      ),
    ),
    auto: optional(fallback(boolean(), false), false),
  }),
  /** POST .../drafts */
  draftsAct: object({
    chapter: whole,
    index: whole,
    action: picklist(['dismiss', 'restore', 'review', 'fix', 'settle']),
  }),
  /** POST .../read: a chapter the reviewer read */
  readNote: object({
    chapter: pipe(
      string(),
      transform((value) => value.slice(0, 200)),
    ),
    head_sha: optional(nullable(string())),
    reason: optional(string()),
    step: whole,
    seconds: optional(nullable(union([number(), string()]))),
  }),
  /** POST .../viewed */
  viewed: object({ path: string(), viewed: flag }),
  /** POST .../approve */
  approve: object({ head_sha: optional(nullable(string())), approved: optional(boolean()) }),
  /** POST .../notes: a new note, or a drafted comment (chapter and index) turned into one */
  noteAdd: object({
    body: optional(string()),
    path: clipped(1000),
    side: optional(fallback(picklist(['L', 'R']), 'R')),
    line: whole,
    chapter: whole,
    index: whole,
  }),
  /** POST .../notes/<id> */
  noteUpdate: object({
    done: optional(boolean()),
    body: optional(string()),
    delete: optional(boolean()),
  }),
  /** POST .../fixes */
  fixesAct: object({
    action: picklist(['send', 'auto', 'take_back']),
    ids: optional(ids),
    on: flag,
    request: optional(nullable(string())),
  }),
  /** POST .../pr */
  prPush: object({
    action: picklist(['push', 'push-ahead']),
    head_sha: optional(nullable(string())),
  }),
  /** POST .../push */
  pushApproved: object({
    action: literal('push'),
    head_sha: optional(nullable(string())),
  }),
} satisfies Record<string, GenericSchema>;

/** What the bridge has always said about a field of these bodies, where a page shows it. */
export const STORY_MESSAGES: Partial<Record<keyof typeof STORY_BODIES, Record<string, string>>> = {
  rebuild: { mode: 'mode is one of rebuild, rebuild_from' },
  listen: { session: 'a session id is needed' },
  questionAsk: { text: 'text is required' },
  questionMarks: {
    action: `action is one of clear, read_all, ${QUESTION_ACTIONS.join(', ')}`,
  },
  draftsAct: { action: 'action must be dismiss, restore or settle' },
  readNote: { chapter: 'a chapter key is needed' },
  fixesAct: { action: 'action is one of send, auto, take_back' },
  prPush: { action: 'action must be push or push-ahead' },
  pushApproved: { action: 'action must be push' },
};
