/*
 * The strict check a writer makes on what it is about to put in a shared file (the formats are schemas.ts). schemas.ts is what
 * a reader takes: lenient, a wrong-typed optional field reads as absent. This is what a writer may give: no `fallback`, so a
 * wrong-typed field is a problem, and the key patterns the writers already enforce on their inputs (a card id, a run id, an
 * `owner/name`, a branch, a sha, a story id) are written once more here, so a writer that builds a line wrongly is caught
 * rather than writing a line the readers then skip or misread.
 *
 * A strict check never reads a file and is never run on a read: it is for lines and records a writer is about to write. It
 * is only as strict as the writers already are on their inputs, so it refuses nothing a live flow can produce (the plan's
 * census, notes/research/2026-11-06-ou-write-checks-plan.md). A field it doesn't list is not checked (`looseObject`).
 * Each function returns the problems, empty when the value may be written.
 */
import {
  array,
  boolean,
  check,
  integer,
  literal,
  looseObject,
  minLength,
  nullable,
  number,
  optional,
  picklist,
  pipe,
  regex,
  safeParse,
  string,
  unknown,
  variant,
  type GenericSchema,
} from 'valibot';
import {
  AGENT_NAME_RE,
  BACKLOG_ID_RE,
  CARD_BRANCH_RE,
  REPO_RE,
  SID_RE,
  STORY_ID_RE,
  SESSION_RE,
} from '@once-upon-a-diff/terms/patterns';
import { RUN_ID_RE, agentId, prKey } from '@once-upon-a-diff/terms/ids';
import { SHA_RE } from '@once-upon-a-diff/terms/text';
import { AGENT_KINDS } from './schemas.ts';

const problemsOf = (schema: GenericSchema, value: unknown): string[] => {
  const result = safeParse(schema, value);
  return result.success
    ? []
    : result.issues.map(
        (issue) =>
          `${issue.path?.map((step) => String(step.key)).join('.') || 'the value'}: ${issue.message}`,
      );
};

/** Absent, null or valid: what a writer gives for an optional field. */
const maybe = <S extends GenericSchema>(schema: S) => optional(nullable(schema));
const matches = (pattern: RegExp, what: string) => pipe(string(), regex(pattern, `is not ${what}`));

/** What every writer stamps its time with (`toISOString`). */
const time = matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'an ISO time');
const repo = matches(REPO_RE, 'owner/name');
const card = matches(BACKLOG_ID_RE, 'a card id (bl_...)');
const branch = matches(CARD_BRANCH_RE, 'a branch name');
const sha = matches(SHA_RE, 'a commit id');
const story = matches(STORY_ID_RE, 'a story id');
const text = string();
const filled = pipe(string(), minLength(1, 'is empty'));

// ---- agents.jsonl ----

const OPEN_STATES = ['running', 'waiting', 'review', 'plan', 'fixing'] as const;
const END_STATES = ['done', 'failed', 'stopped'] as const;

const agentCommon = {
  v: maybe(number()),
  id: matches(/^[0-9a-f]{8}:[\w.-]{1,100}$/, 'sid8:name'),
  sid8: matches(SID_RE, 'a session id (8 hex)'),
  name: matches(AGENT_NAME_RE, 'an agent name'),
  at: time,
  by: maybe(text),
  session: maybe(text),
  // a start mints its run (checked below); a state, beat or finish copies the open run's, whatever form an older writer gave it
  run: maybe(text),
  standing: maybe(boolean()),
  task: maybe(text),
  model: maybe(text),
  effort: maybe(text),
  repo: maybe(repo),
  branch: maybe(branch),
  tip: maybe(text),
  pr: maybe(number()),
  cwd: maybe(text),
  card: maybe(card),
  lane: maybe(text),
  notes: maybe(text),
  slots: maybe(number()),
  outcome: maybe(text),
  findings: maybe(number()),
  result: maybe(
    looseObject({
      commit: maybe(sha),
      pr: maybe(number()),
      branch: maybe(branch),
      card: maybe(card),
    }),
  ),
};

const StrictAgentEvent = pipe(
  variant('op', [
    looseObject({
      ...agentCommon,
      op: literal('start'),
      run: matches(RUN_ID_RE, 'a run id (r_ and 10 hex)'),
      kind: picklist(AGENT_KINDS),
      task: filled,
    }),
    looseObject({ ...agentCommon, op: literal('state'), state: picklist(OPEN_STATES) }),
    looseObject({
      ...agentCommon,
      op: literal('beat'),
      n: number(),
      of: number(),
      step: text,
      note: maybe(text),
    }),
    looseObject({ ...agentCommon, op: literal('branch'), branch }),
    looseObject({ ...agentCommon, op: literal('finish'), state: picklist(END_STATES) }),
  ]),
  check((event) => event.id === agentId(event.sid8, event.name), 'id is not sid8:name'),
);

/** The problems with an agents.jsonl event a writer is about to append (the line as written, with its `v`). */
export const strictAgentEvent = (value: unknown): string[] => problemsOf(StrictAgentEvent, value);

// ---- backlog.jsonl ----

const stamped = { id: card, at: time, by: filled };
const StrictBacklogEvent = variant('op', [
  looseObject({
    op: literal('add'),
    ...stamped,
    title: filled,
    note: maybe(text),
    repo: maybe(repo),
    branch: maybe(branch),
  }),
  looseObject({ op: literal('start'), ...stamped, branch, repo: maybe(repo) }),
  looseObject({
    op: literal('assign'),
    ...stamped,
    session: matches(SESSION_RE, 'a session id'),
    branch: maybe(branch),
  }),
  looseObject({ op: literal('done'), ...stamped, sha: maybe(sha) }),
  looseObject({
    op: literal('claim'),
    ...stamped,
    agent: matches(AGENT_NAME_RE, 'an agent name'),
    sid: maybe(matches(SID_RE, 'a session id (8 hex)')),
    session: maybe(matches(SESSION_RE, 'a session id')),
    worktree: maybe(text),
  }),
  looseObject({ op: literal('hold'), ...stamped, on: boolean() }),
  looseObject({ op: literal('someday'), ...stamped, on: boolean() }),
  looseObject({ op: literal('drop'), ...stamped }),
  looseObject({ op: literal('reopen'), ...stamped }),
  looseObject({
    op: literal('move'),
    ...stamped,
    before: maybe(card),
    edge: maybe(picklist(['top', 'bottom'])),
  }),
  looseObject({
    op: literal('edit'),
    ...stamped,
    title: maybe(filled),
    note: maybe(text),
    // an empty repo clears it
    repo: maybe(pipe(string(), regex(/^$|^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/))),
  }),
]);

/** The problems with a backlog.jsonl event a writer is about to append (with the `at` it will be stamped with). */
export const strictBacklogEvent = (value: unknown): string[] =>
  problemsOf(StrictBacklogEvent, value);

// ---- inbox.jsonl ----

const entry = <T extends string, E extends Record<string, GenericSchema>>(type: T, fields: E) =>
  looseObject({
    type: literal(type),
    id: filled,
    at: time,
    kind: maybe(text),
    title: maybe(text),
    // a repo is a story's own, never typed: it is not checked for its shape
    repo: maybe(text),
    story: maybe(story),
    ...fields,
  });

const StrictInboxEntry = variant('type', [
  entry('question', {
    story,
    step: maybe(number()),
    chapter: maybe(text),
    file: maybe(text),
    text: filled,
    url: maybe(text),
    channel: maybe(literal('voice')),
  }),
  entry('answer', {
    question: filled,
    text,
    by: maybe(text),
    refs: maybe(array(looseObject({}))),
  }),
  entry('note', {
    action: picklist(['added', 'updated', 'deleted']),
    from_draft: maybe(boolean()),
    note: looseObject({}),
  }),
  entry('fix', {
    action: picklist(['sent', 'fixed', 'failed']),
    request: filled,
    notes: maybe(array(text)),
    to: maybe(text),
    sha: maybe(text),
    by: maybe(text),
  }),
  entry('read', {
    chapter: filled,
    step: maybe(number()),
    head_sha: maybe(text),
    story_head: maybe(text),
    reason: maybe(text),
  }),
  entry('approved', {
    story,
    branch: maybe(text),
    checkout: maybe(text),
    base: maybe(text),
    head_sha: filled,
  }),
  entry('review_comment', {
    chapter: maybe(number()),
    path: filled,
    line: number(),
    url: maybe(text),
    started: maybe(boolean()),
  }),
  entry('comment', { chapter: number(), comment: unknown() }),
]);

/** The problems with an inbox.jsonl entry a writer is about to append (with its id and time). */
export const strictInboxEntry = (value: unknown): string[] => problemsOf(StrictInboxEntry, value);

// ---- builds.json and fixes.json ----

/** a request's time as the writers put it (`toISOString`, or an older writer's without milliseconds): any time `Date` reads */
const when = pipe(
  string(),
  check((value) => !Number.isNaN(Date.parse(value)), 'is not an ISO time'),
);
const requested = { id: filled, requested_at: when };

const StrictBuild = looseObject({
  ...requested,
  status: picklist(['pending', 'done', 'failed']),
  number: maybe(pipe(number(), integer())),
  story: maybe(story),
});

/**
 * The problems with a build request a writer is about to put in builds.json under `key`: `owner/repo#N` (lower case) for a
 * PR's, `story:<id>` for a local story's rebuild. A PR's repo is `owner/name`.
 */
export function strictBuild(value: unknown, key: string): string[] {
  const found = problemsOf(StrictBuild, value);
  if (found.length || typeof value !== 'object' || value === null) {
    return found;
  }
  const build = value as { repo?: unknown; number?: unknown };
  if (typeof build.number === 'number') {
    if (typeof build.repo !== 'string' || !REPO_RE.test(build.repo)) {
      found.push('repo: is not owner/name');
    } else if (key !== prKey(build.repo, build.number)) {
      found.push(`key ${key} is not the PR's key`);
    }
  } else if (!key.startsWith('story:')) {
    found.push(`key ${key} has no PR number and is not story:<id>`);
  }
  return found;
}

const StrictFix = looseObject({
  ...requested,
  story,
  kind: picklist(['github', 'local']),
  status: picklist(['pending', 'done', 'failed', 'taken_back']),
  notes: maybe(
    array(
      looseObject({
        id: filled,
        path: filled,
        side: picklist(['L', 'R']),
        body: text,
      }),
    ),
  ),
});

/** The problems with a fix request a writer is about to put in fixes.json under `key` (its id). */
export function strictFixRequest(value: unknown, key: string): string[] {
  const found = problemsOf(StrictFix, value);
  const id = (value as { id?: unknown } | null)?.id;
  if (!found.length && id !== key) {
    found.push(`key ${key} is not the request's id`);
  }
  return found;
}
