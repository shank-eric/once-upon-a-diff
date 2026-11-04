/*
 * The request-body schemas, one per route that takes a body (routes.ts names them in BODIES). The bridge checks every
 * body against its schema, so a handler reads typed values and never `String(body.x || '')`. Server side only: it
 * imports valibot, so the bridge never serves this file to a page, and routes.ts takes the body types from it with
 * `import type`, which is erased. A page or the extension therefore never loads valibot.
 *
 * Every schema is an `object`, which drops fields it doesn't list. Where the server used to take anything and quietly
 * fall back to a default (page settings, the panel's saved state), the schema says so with `fallback` and the
 * answer doesn't change. Where a handler had a message the page shows, FIELD_MESSAGES carries the same text.
 */
import {
  array,
  boolean,
  check,
  fallback,
  integer,
  literal,
  minValue,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  regex,
  string,
  transform,
  safeParse,
  union,
  unknown,
  type GenericSchema,
  type InferOutput,
} from 'valibot';
import { MAX_BATCH_ENTRIES } from './domain/usage-actions.ts';
import { BACKLOG_ID_RE, BRANCH_RE, REPO_RE, SESSION_RE } from './domain/patterns.ts';

/** The ids and lists the bridge caps, so a body can't make it hold more. */
const MAX_IDS = 500;
const MAX_LIST = 100;

/** A string cut to `max`, null for none (a missing value, or null). */
const clipped = (max: number) =>
  optional(
    pipe(
      nullable(string()),
      transform((value): string | null => (value == null ? null : value.slice(0, max))),
    ),
    null,
  );

/** A number or a numeric string as a whole number, null for anything else (and for none). */
const toWhole = (value: number | string | null): number | null => {
  if (value == null) {
    return null;
  }
  return Number.isFinite(+value) ? Math.trunc(+value) : null;
};

/** A whole number from a number or a numeric string, null for anything else. */
const whole = optional(pipe(nullable(union([number(), string()])), transform(toWhole)), null);

/** `true` or `false`, and `false` for anything else (and when missing). */
const flag = optional(fallback(boolean(), false), false);

/** A Claude Code session id. */
const sessionId = pipe(string(), regex(SESSION_RE));

/** A list of strings, or one string, as a list: empty ones dropped, at most MAX_LIST. */
const names = optional(
  fallback(
    pipe(
      union([string(), array(string())]),
      transform((value) =>
        (Array.isArray(value) ? value : [value]).filter((one) => one !== '').slice(0, MAX_LIST),
      ),
    ),
    [],
  ),
  [],
);

/** Ids as a list, at most MAX_IDS. */
const ids = pipe(
  array(string()),
  transform((list) => list.slice(0, MAX_IDS)),
);

/** What the extension saw you do on a GitHub page (a refresh's reason, for the bridge's log line). */
export const GITHUB_REFRESH_REASONS = ['review', 'open', 'merge', 'ready', 'close'] as const;
const MOVE_NEEDS = 'before (an item id) or edge (top or bottom) is needed';
const QUESTION_ACTIONS = ['dismiss', 'restore', 'collapse', 'expand', 'read', 'unread'] as const;

export const BODIES = {
  /** POST /api/prefs and .../prefs: page settings; anything else is dropped, a bad view is unified */
  prefs: object({
    hideWhitespace: optional(fallback(boolean(), false)),
    diffView: optional(fallback(picklist(['unified', 'split']), 'unified')),
    layout: optional(
      fallback(
        nullable(
          object({
            width: optional(fallback(nullable(number()), null)),
            chatHeight: optional(fallback(nullable(number()), null)),
          }),
        ),
        null,
      ),
    ),
  }),
  /** POST /api/usage and .../usage: counts by action name. The bridge keeps only the names domain/usage-actions.ts lists. */
  usage: object({
    counts: pipe(
      record(string(), number()),
      check(
        (counts) => Object.keys(counts).length <= MAX_BATCH_ENTRIES,
        'too many actions in one batch',
      ),
    ),
  }),
  /** POST /api/stories/status-many */
  statusMany: object({
    // a list that isn't one of PRs gets no results, as it always has
    prs: optional(
      fallback(
        pipe(
          array(object({ repo: string(), number: number() })),
          transform((list) => list.slice(0, 200)),
        ),
        [],
      ),
      [],
    ),
  }),
  /** POST /api/builds */
  buildRequest: object({
    repo: string(),
    number: union([number(), string()]),
    mode: optional(string()),
    base_sha: optional(string()),
    retell: optional(fallback(boolean(), false), false),
    requested_at: optional(string()),
  }),
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
  /** POST /auth/session */
  authSession: object({ key: optional(string(), '') }),
  /** POST /api/board/type */
  boardType: object({
    kind: picklist(['build', 'listen']),
    session: sessionId,
    repo: optional(nullable(string())),
    story: optional(nullable(string())),
  }),
  boardVoicePause: object({ paused: boolean() }),
  boardVoicePhone: object({ on: boolean() }),
  boardVoiceStart: object({ session: optional(sessionId) }),
  boardStopListening: object({ repo: optional(string(), '') }),
  boardFocus: object({ session: sessionId }),
  boardOpenStory: object({ story: optional(string(), '') }),
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
  /** POST /api/github/refresh: what the extension saw you do on GitHub (page-made, so every field is checked) */
  githubRefresh: pipe(
    object({
      repo: pipe(string(), regex(REPO_RE)),
      branch: optional(pipe(string(), regex(BRANCH_RE))),
      number: optional(pipe(number(), integer(), minValue(1))),
      reason: picklist(GITHUB_REFRESH_REASONS),
    }),
    check((body) => !!body.branch || !!body.number, 'a branch or a PR number is needed'),
  ),
} satisfies Record<string, GenericSchema>;

/** The name of a body schema in BODIES. */
export type BodyName = keyof typeof BODIES;

/**
 * What the bridge has always said about a field, where a page shows it, by body and field. Valibot's own message for
 * a missing key doesn't name the field, so the message comes from here.
 */
const FIELD_MESSAGES: Partial<Record<BodyName, Record<string, string>>> = {
  buildRequest: { repo: 'bad repo', number: 'bad number' },
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
  boardType: {
    kind: 'a kind (build or listen) and a session id are needed',
    session: 'a kind (build or listen) and a session id are needed',
  },
  boardVoicePause: { paused: 'paused (true or false) is needed' },
  boardVoicePhone: { on: 'on (true or false) is needed' },
  boardVoiceStart: { session: 'session must be a session id' },
  githubRefresh: { repo: 'bad repo', branch: 'bad branch', number: 'bad number' },
  boardFocus: { session: 'a session id is needed' },
  boardBacklogMove: { edge: MOVE_NEEDS },
  boardBacklogAssign: { id: 'a backlog item id is needed' },
  boardBacklogEdit: { id: 'a backlog item id is needed' },
};

/** What checkBody says: the body as the schema reads it, or why it can't. */
export type Checked<Name extends BodyName> =
  { ok: true; output: InferOutput<(typeof BODIES)[Name]> } | { ok: false; message: string };

/**
 * Checks a body against one of the schemas. A field the bridge has a message for says it (FIELD_MESSAGES), a check's own
 * message goes out as it is, and valibot's own wording, which echoes the value it got, becomes "<field> is not valid".
 */
export function checkBody<Name extends BodyName>(name: Name, body: unknown): Checked<Name> {
  const result = safeParse(BODIES[name], body);
  if (result.success) {
    return { ok: true, output: result.output as InferOutput<(typeof BODIES)[Name]> };
  }
  const [issue] = result.issues;
  const field = String(issue.path?.[0]?.key ?? '');
  const said = FIELD_MESSAGES[name]?.[field];
  if (said) {
    return { ok: false, message: said };
  }
  const where = (issue.path || []).map((step) => String(step.key)).join('.') || 'the body';
  return {
    ok: false,
    message: issue.message.startsWith('Invalid ') ? `${where} is not valid` : issue.message,
  };
}
