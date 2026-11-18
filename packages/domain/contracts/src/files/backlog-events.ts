/*
 * backlog.jsonl's event format (ADR-29 widened it): what each event carries, as a reader takes it. Lenient on read like every file
 * schema here (schemas.ts says why); strict.ts is what a writer may give. What each event means is state/src/queues/backlog/backlog.ts.
 */
import {
  boolean,
  literal,
  looseObject,
  number,
  picklist,
  pipe,
  regex,
  string,
  variant,
} from 'valibot';
import { AGENT_NAME_RE, BACKLOG_ID_RE, SESSION_RE, SID_RE } from '@once-upon-a-diff/terms/patterns';
import { lenient, reader } from './readers.ts';

const id = pipe(string(), regex(BACKLOG_ID_RE));
/** What made a card (ADR-29): a backlog add, or the first fact that learned of the work. Only `backlog` cards are listed in the Backlog column. */
export const CARD_SOURCES = ['backlog', 'agent', 'session', 'pr', 'story'] as const;
/** What every event has: who (`cli` when absent) and when (stamped by the writer). */
const stamped = { id, at: lenient(string()), by: lenient(string()) };

/**
 *   {op:'add',   id, title, note, repo, branch, source?, worktree?, pr?, story?, session?, by, at}   `source` is what made the card (ADR-29); no source reads as `backlog`
 *   {op:'start', id, branch, repo, by, at}     work began on that branch
 *   {op:'assign', id, session, branch, by, at} an Assign typed the item into a session
 *   {op:'link',  id, repo?, branch?, worktree?, pr?, story?, session?, source?, by, at}   a fact learned about the card, written once (ADR-29); `source` only as `backlog` (adopt)
 *   {op:'done',  id, sha?, merged_at?, by, at} the work landed (`merged_at`: when its PR merged, when GitHub said so)
 *   {op:'drop' | 'reopen', id, by, at}
 *   {op:'move',  id, before | edge, by, at}    `before` is another item's id; `edge` is 'top' or 'bottom'
 *   {op:'edit',  id, title?, note?, repo?, by, at}
 *   {op:'claim', id, agent, sid?, session?, worktree?, by, at}   an agent (named as it registered) owns the card; `session` is the
 *                                              claimer's full session id (the editor's) and `worktree` the checkout path, when given
 *   {op:'hold' | 'someday' | 'skip_critic', id, on, by, at}
 * What each means, and how they fold into items, is state/src/queues/backlog/backlog.ts.
 */
const BacklogEventSchema = variant('op', [
  looseObject({
    op: literal('add'),
    ...stamped,
    title: string(),
    note: lenient(string()),
    repo: lenient(string()),
    branch: lenient(string()),
    source: lenient(picklist(CARD_SOURCES)),
    worktree: lenient(string()),
    pr: lenient(number()),
    story: lenient(string()),
    session: lenient(string()),
  }),
  looseObject({ op: literal('start'), ...stamped, branch: string(), repo: lenient(string()) }),
  looseObject({
    op: literal('link'),
    ...stamped,
    repo: lenient(string()),
    branch: lenient(string()),
    worktree: lenient(string()),
    pr: lenient(number()),
    story: lenient(string()),
    session: lenient(string()),
    source: lenient(literal('backlog')),
  }),
  looseObject({
    op: literal('assign'),
    ...stamped,
    session: pipe(string(), regex(SESSION_RE)),
    branch: lenient(string()),
  }),
  looseObject({
    op: literal('done'),
    ...stamped,
    sha: lenient(string()),
    merged_at: lenient(string()),
  }),
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
  looseObject({ op: literal('skip_critic'), ...stamped, on: lenient(boolean()) }),
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
export const readBacklogEvent = reader(BacklogEventSchema);
