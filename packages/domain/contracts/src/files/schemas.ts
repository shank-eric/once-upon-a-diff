/*
 * The formats of the files the CLI and the bridge share under ~/.once-upon: agents.jsonl, backlog.jsonl and inbox.jsonl (an
 * event or an entry a line, appended) and builds.json and fixes.json (a record by key, rewritten whole under a lock). They
 * are written by one process and read by another, so this is their contract, and the one place their shape is written: core's
 * stores read and write through it, and neither app has a copy. Server side only: it imports valibot, so the bridge never
 * serves this file to a page.
 *
 * A file outlives the code that wrote it, so each schema accepts what older code wrote and later code may add:
 *   - an object keeps the fields it doesn't list (a `looseObject`); and RequestQueue, which rewrites builds.json and
 *     fixes.json whole, writes a record back as it was on disk with only the fields a write changed, so a field the schema
 *     doesn't list or doesn't accept (a newer writer's kind, one bad note) survives a write
 *   - only what a reader can't do without is required (the id, the op or type, the time); every other field is `lenient`:
 *     absent, null or of the wrong type reads as absent (null stays null), which is what the readers did with such a field
 *   - an event or entry that fails (an unknown op or type, a missing id) is skipped by the readers, as a line that isn't
 *     JSON always was. The three logs are never rewritten, so skipping loses nothing; a whole record of the two queues that
 *     fails is carried through a write untouched.
 * The readers below return the value or null, so core needs no valibot of its own.
 */
import {
  array,
  boolean,
  check,
  custom,
  fallback,
  literal,
  looseObject,
  nullable,
  number,
  optional,
  picklist,
  pipe,
  regex,
  safeParse,
  string,
  transform,
  unknown,
  variant,
  type GenericSchema,
  type InferOutput,
} from 'valibot';
import { AGENT_NAME_RE, BACKLOG_ID_RE, SESSION_RE, SID_RE } from '@once-upon-a-diff/terms/patterns';
import type { ChapterRef, LocalNote } from '../story/types.ts';

/** An output type without the index signature `looseObject` adds: the fields the schema lists, as an interface would say them. */
type Listed<T> = T extends unknown
  ? { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] }
  : never;

/** A field no reader depends on: absent, null, or of the wrong type reads as absent (null stays null). */
const lenient = <S extends GenericSchema>(schema: S) =>
  optional(fallback(nullable(schema), undefined));
/** Like `lenient`, but null reads as absent too, for a field whose type never allowed null. */
const absent = <S extends GenericSchema>(schema: S) => optional(fallback(schema, undefined));
const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isoTime = pipe(
  string(),
  check((text) => !Number.isNaN(Date.parse(text))),
);

/** The value the schema accepts, or null. */
const reader =
  <S extends GenericSchema>(schema: S) =>
  (value: unknown): InferOutput<S> | null => {
    const result = safeParse(schema, value);
    return result.success ? result.output : null;
  };

// ---- agents.jsonl: the registry's events (state/src/records/agents) ----

/**
 * What an agent is. `editor` is not an agent but a session that runs a repo's build queue (`/once-upon-editor`): it
 * registers itself so the board can show it with the authors it controls (the ones launched under its session id).
 */
export const AGENT_KINDS = ['author', 'critic', 'helper', 'research', 'editor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** Old names for a kind, still read from old agents.jsonl lines and still accepted by `agent start --kind`. */
export const KIND_ALIASES = { builder: 'author', reviewer: 'critic' } as const;

const AgentResultSchema = looseObject({
  commit: lenient(string()),
  pr: lenient(number()),
  branch: lenient(string()),
  card: lenient(string()),
});
/** What a finished run made: each part optional. */
export type AgentResult = Listed<InferOutput<typeof AgentResultSchema>>;

/**
 *   {op:'start',  v, id, sid8, session, name, at, by, run, kind, standing, task, model, effort, repo, branch, tip, pr, cwd, card, lane, notes, slots}
 *   {op:'state',  ..., state: running|waiting|review|plan|fixing, outcome, findings, notes}
 *   {op:'beat',   ..., n, of, step, note}                 also the heartbeat: it counts as the agent's last sign of life
 *   {op:'finish', ..., state: done|failed|stopped, outcome, result: {commit, pr, branch, card}, findings, notes}
 * `id` is `<sid8>:<name>`. `kind` is as stored: an old line may still say `builder` or `reviewer`, and a kind nobody knows reads as none.
 */
export const AgentEventSchema = looseObject({
  op: picklist(['start', 'state', 'beat', 'finish']),
  v: lenient(number()),
  id: string(),
  sid8: string(),
  name: string(),
  at: isoTime,
  session: lenient(string()),
  by: lenient(string()),
  run: lenient(string()),
  kind: lenient(
    picklist([...AGENT_KINDS, ...(Object.keys(KIND_ALIASES) as (keyof typeof KIND_ALIASES)[])]),
  ),
  /** a long-lived agent reached by SendMessage, never finished between requests: the board's Helpers row, no card */
  standing: lenient(boolean()),
  task: lenient(string()),
  model: lenient(string()),
  effort: lenient(string()),
  repo: lenient(string()),
  branch: lenient(string()),
  /** start only: the registered branch's tip then, or null */
  tip: lenient(string()),
  pr: lenient(number()),
  cwd: lenient(string()),
  card: lenient(string()),
  lane: lenient(string()),
  notes: lenient(string()),
  /** an editor's build slots */
  slots: lenient(number()),
  state: lenient(string()),
  outcome: lenient(string()),
  findings: lenient(number()),
  result: lenient(AgentResultSchema),
  n: lenient(number()),
  of: lenient(number()),
  step: lenient(string()),
  note: lenient(string()),
});
export type AgentEvent = Listed<InferOutput<typeof AgentEventSchema>>;
export const readAgentEvent = reader(AgentEventSchema);

// ---- backlog.jsonl: the Backlog column's events (state/src/queues/backlog) ----

const id = pipe(string(), regex(BACKLOG_ID_RE));
/** What every event has: who (`cli` when absent) and when (stamped by the writer). */
const stamped = { id, at: lenient(string()), by: lenient(string()) };

/**
 *   {op:'add',   id, title, note, repo, branch, by, at}
 *   {op:'start', id, branch, repo, by, at}     work began on that branch
 *   {op:'assign', id, session, branch, by, at} an Assign typed the item into a session
 *   {op:'done',  id, sha?, by, at}             the work landed
 *   {op:'drop' | 'reopen', id, by, at}
 *   {op:'move',  id, before | edge, by, at}    `before` is another item's id; `edge` is 'top' or 'bottom'
 *   {op:'edit',  id, title?, note?, repo?, by, at}
 *   {op:'claim', id, agent, sid?, session?, worktree?, by, at}   an agent (named as it registered) owns the card; `session` is the
 *                                              claimer's full session id (the editor's) and `worktree` the checkout path, when given
 *   {op:'hold' | 'someday', id, on, by, at}
 * What each means, and how they fold into items, is state/src/queues/backlog/backlog.ts.
 */
export const BacklogEventSchema = variant('op', [
  looseObject({
    op: literal('add'),
    ...stamped,
    title: string(),
    note: lenient(string()),
    repo: lenient(string()),
    branch: lenient(string()),
  }),
  looseObject({ op: literal('start'), ...stamped, branch: string(), repo: lenient(string()) }),
  looseObject({
    op: literal('assign'),
    ...stamped,
    session: pipe(string(), regex(SESSION_RE)),
    branch: lenient(string()),
  }),
  looseObject({ op: literal('done'), ...stamped, sha: lenient(string()) }),
  looseObject({
    op: literal('claim'),
    ...stamped,
    agent: pipe(string(), regex(AGENT_NAME_RE)),
    sid: lenient(pipe(string(), regex(SID_RE))),
    session: lenient(pipe(string(), regex(SESSION_RE))),
    worktree: lenient(string()),
  }),
  looseObject({ op: literal('hold'), ...stamped, on: lenient(boolean()) }),
  looseObject({ op: literal('someday'), ...stamped, on: lenient(boolean()) }),
  looseObject({ op: literal('drop'), ...stamped }),
  looseObject({ op: literal('reopen'), ...stamped }),
  looseObject({
    op: literal('move'),
    ...stamped,
    before: lenient(string()),
    edge: lenient(picklist(['top', 'bottom'])),
  }),
  looseObject({
    op: literal('edit'),
    ...stamped,
    title: lenient(string()),
    note: lenient(string()),
    repo: lenient(string()),
  }),
]);
export type BacklogEvent = Listed<InferOutput<typeof BacklogEventSchema>>;
export const readBacklogEvent = reader(BacklogEventSchema);

// ---- inbox.jsonl: questions, answers, notes and the like (state/src/queues/requests/inbox.ts) ----

const inboxEntry = <T extends string, E extends Record<string, GenericSchema>>(
  type: T,
  fields: E,
) =>
  looseObject({
    type: literal(type),
    id: string(),
    at: string(),
    kind: lenient(string()),
    title: lenient(string()),
    repo: lenient(string()),
    ...fields,
  });
const objectOf = <T>() => custom<T>(isObject);

/**
 * One line of inbox.jsonl: `type`, `id`, `at` and, for a story's, `story`. A type nobody reads (the `position`,
 * `build_request` and `build_done` lines older versions logged) is skipped, as the readers always ignored it.
 *   question       asked in the panel's Ask box or by voice
 *   answer         `once-upon answer`, to a question
 *   note           a fix-before-push note added, updated or deleted
 *   fix            a fix request sent, fixed or failed (the requests themselves are in fixes.json)
 *   read           a chapter read
 *   approved       Approve was clicked on a local story's page (or `once-upon approve` ran)
 *   review_comment a comment posted to GitHub
 *   comment        a drafted comment
 */
export const InboxEntrySchema = variant('type', [
  inboxEntry('question', {
    story: string(),
    step: lenient(number()),
    chapter: lenient(string()),
    file: lenient(string()),
    text: string(),
    url: lenient(string()),
    /** asked by voice (`once-upon ask --voice`) rather than typed in the panel's Ask box */
    channel: lenient(literal('voice')),
  }),
  inboxEntry('answer', {
    story: lenient(string()),
    question: string(),
    text: string(),
    by: lenient(string()),
    /** the places the text links to (`[text](ref:<id>)`) */
    refs: lenient(array(objectOf<ChapterRef>())),
  }),
  inboxEntry('note', {
    story: lenient(string()),
    action: picklist(['added', 'updated', 'deleted']),
    from_draft: lenient(boolean()),
    note: objectOf<LocalNote>(),
  }),
  inboxEntry('fix', {
    story: lenient(string()),
    action: picklist(['sent', 'fixed', 'failed']),
    request: string(),
    notes: lenient(array(string())),
    to: lenient(string()),
    sha: lenient(string()),
    by: lenient(string()),
  }),
  inboxEntry('read', {
    story: lenient(string()),
    chapter: string(),
    step: lenient(number()),
    title: lenient(string()),
    head_sha: lenient(string()),
    story_head: lenient(string()),
    reason: lenient(string()),
  }),
  inboxEntry('approved', {
    story: string(),
    branch: lenient(string()),
    checkout: lenient(string()),
    base: lenient(string()),
    head_sha: string(),
  }),
  inboxEntry('review_comment', {
    story: lenient(string()),
    chapter: lenient(number()),
    path: string(),
    line: number(),
    url: lenient(string()),
    started: lenient(boolean()),
  }),
  inboxEntry('comment', {
    story: lenient(string()),
    chapter: number(),
    comment: custom<unknown>(() => true),
  }),
]);
export type InboxEntry = Listed<InferOutput<typeof InboxEntrySchema>>;
export const readInboxEntry = reader(InboxEntrySchema);

// ---- builds.json and fixes.json: request records by key (state/src/queues/requests) ----

/** What every queued request has. */
const queued = {
  id: string(),
  requested_at: string(),
  claimed_by: absent(string()),
  claimed_at: absent(string()),
  done_at: absent(string()),
};

/** A chapter read before an update was asked for: where the reviewer's reading stopped. */
const BuildReadSchema = looseObject({
  chapter: string(),
  title: optional(fallback(nullable(string()), null), null),
  sha: optional(fallback(nullable(string()), null), null),
  at: string(),
});
export type BuildRead = Listed<InferOutput<typeof BuildReadSchema>>;

/**
 * A build request, as builds.json keeps it, by `repo#number` (or `story:<id>` for a local story's rebuild): "there's no story
 * for this PR yet", "bring it up to the PR's latest commit" (mode 'update') or "tell it again" (mode 'rebuild' or 'rebuild_from').
 */
export const BuildSchema = looseObject({
  ...queued,
  repo: lenient(string()),
  number: optional(fallback(nullable(number()), null), null),
  url: optional(fallback(nullable(string()), null), null),
  status: picklist(['pending', 'done', 'failed']),
  mode: absent(picklist(['update', 'rebuild', 'rebuild_from'])),
  started_at: absent(string()),
  // an update
  base_sha: absent(string()),
  retell: absent(boolean()),
  since_sha: absent(string()),
  since_source: lenient(string()),
  reads: absent(array(BuildReadSchema)),
  story: lenient(string()),
  // a rebuild
  kind: absent(picklist(['github', 'local'])),
  from_step: absent(number()),
  guidance: absent(string()),
  told_from: lenient(string()),
  story_dir: lenient(string()),
  local: absent(
    looseObject({ repo_path: absent(string()), base: absent(string()), head: absent(string()) }),
  ),
  note: lenient(string()),
});
export type Build = Listed<InferOutput<typeof BuildSchema>>;
export const readBuild = reader(BuildSchema);

const RequestNoteSchema = looseObject({
  id: string(),
  path: string(),
  side: picklist(['L', 'R']),
  /** null for a note on a whole file */
  line: nullable(number()),
  body: string(),
  chapter: optional(fallback(nullable(number()), null), null),
  /** the note came from a drafted comment (Add to fix before push): the session confirms it before acting */
  from_draft: optional(fallback(boolean(), false), false),
});
export type RequestNote = Listed<InferOutput<typeof RequestNoteSchema>>;
const readNote = reader(RequestNoteSchema);

/** A fix request, as fixes.json keeps it, by request id: a batch of notes handed to a session. */
export const FixRequestSchema = looseObject({
  ...queued,
  story: string(),
  repo: optional(fallback(nullable(string()), null), null),
  kind: picklist(['github', 'local']),
  title: optional(fallback(nullable(string()), null), null),
  url: optional(fallback(nullable(string()), null), null),
  branch: optional(fallback(nullable(string()), null), null),
  checkout: optional(fallback(nullable(string()), null), null),
  // a note the schema refuses is left out of this view, and stays in the file: it never takes its siblings with it
  notes: optional(
    fallback(
      pipe(
        array(unknown()),
        transform((notes) => notes.flatMap((note) => readNote(note) ?? [])),
      ),
      [],
    ),
    [],
  ),
  to: optional(fallback(nullable(string()), null), null),
  status: picklist(['pending', 'done', 'failed', 'taken_back']),
  sha: lenient(string()),
  fixed: absent(array(string())),
  why: lenient(string()),
  by: lenient(string()),
});
export type FixRequest = Listed<InferOutput<typeof FixRequestSchema>>;
export const readFixRequest = reader(FixRequestSchema);
