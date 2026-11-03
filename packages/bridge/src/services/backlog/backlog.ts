/**
 * The board's Backlog column: things to do later, kept by Once Upon in <home>/backlog.jsonl. One JSON event a line,
 * appended (never rewritten), so the CLI (in-process) and the bridge (page clicks) can both write without a lock, and
 * a drop is recoverable by hand. Everything goes through BacklogStore, so the file can be swapped for another store
 * without touching the board or the CLI.
 *
 *   {op:'add',   id, title, note, repo, branch, by, at}
 *   {op:'start', id, branch, repo, by, at}     work began on that branch
 *   {op:'done',  id, sha?, by, at}             the work landed (a local deploy: no PR ever merges it); an open item can land too
 *   {op:'drop',  id, by, at}
 *   {op:'reopen', id, by, at}                  a dropped item is open again (a new `start` after a drop is still ignored)
 *   {op:'move',  id, before | edge, by, at}   `before` is another item's id; `edge` is 'top' or 'bottom'
 *   {op:'edit',  id, title?, note?, repo?, by, at}   only the fields that changed; an empty note or repo clears it. An open item only
 *   {op:'claim', id, agent, sid?, by, at}     an agent (named as in the ledger) owns the card: the one link from a card to an
 *                                              agent (claims.ts). The latest claim wins; a reopen clears it
 *   {op:'hold',  id, on, by, at}              the card lands by hand: a deploy never marks it done (landing.ts), only `done ID` does.
 *                                              `on:false` clears it; a reopen clears it too. Sticky across claims
 *
 * The items come back in order: an add goes to the bottom, and a move puts one item before another or at an edge.
 * A move names where it goes relative to the other items, never an index, so it folds the same whatever was added or
 * dropped in between, and the page shows the order within each repo lane.
 *
 * An open item is a card in the Backlog column, in its repo's lane. A started item leaves the column and is one piece of
 * work shown once: it rides on the card its work is on (the work card for its repo and branch: "from backlog"), or, with
 * no card, is a card of its own in Working (so a wrong branch name doesn't make
 * it vanish: STARTED_GRACE_HOURS, or as long as a worktree, session or agent is found on it, backlog-links.ts) and then
 * in Done once it merged, landed or its agent finished. That is worked out on read, so a board snapshot never writes.
 */
import { BACKLOG_ID_RE } from '@once-upon-a-diff/protocol/domain/patterns';
import { appendBacklogEvent, readBacklogFile } from '../../adapters/stores/backlog-file.ts';
import path from 'node:path';
import { liveClaim, sameAgentView } from './claims.ts';
import { REPO_RE, sameRepo } from '../config/repos.ts';
import { newId } from '../inbox/inbox.ts';
import type { BoardAgent, BoardCard, BoardStartedLinks } from '@once-upon-a-diff/protocol/types';

export const STARTED_GRACE_HOURS = 24;
/** A started item whose work merged or landed, or whose agent finished, stays in Done this long. */
export const DONE_HOURS = 24;
/** An assignment that no `start` followed is a hint for this long, then the item is free to hand to another session. */
export const ASSIGN_HOURS = 2;

export const ID_PATTERN = BACKLOG_ID_RE;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const AGENT_PATTERN = /^[\w.-]{1,100}$/;
const SID_PATTERN = /^[0-9a-f]{8}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const TITLE_MAX = 200;
const NOTE_MAX = 1000;
const BY_MAX = 40;

/** One item as its events fold. */
export interface BacklogItem {
  id: string;
  title: string;
  note: string | null;
  repo: string | null;
  branch: string | null;
  added_by: string;
  added_at: string;
  state: 'open' | 'started' | 'dropped';
  started_at: string | null;
  started_by: string | null;
  dropped_at: string | null;
  /** when a `done` event recorded the work as landed (started items only), and the sha it landed as, when given */
  landed_at: string | null;
  landed_sha: string | null;
  /** the latest session an Assign typed the item into; kept until a start or a drop (shown for ASSIGN_HOURS) */
  assigned: { session: string; branch: string | null; at: string } | null;
  /** the agent that claimed the card (named as in the ledger, with its launching session's first 8 when given); cleared by a reopen */
  claim: { agent: string; sid: string | null; by: string; at: string } | null;
  /** the card lands by hand: a deploy does not mark it done (part of its work lands outside the repo) */
  hold: boolean;
}

/** Where a move puts an item: before another one, or at the top or the bottom. */
export type MoveTo = { before: string } | { edge: 'top' | 'bottom' };

/** What an edit changes: a field left out (undefined) stays; an empty note or repo clears it. */
export interface EditInput {
  title?: string;
  note?: string | null;
  repo?: string | null;
}

export interface AddInput {
  title: string;
  note?: string | null;
  repo?: string | null;
  branch?: string | null;
  by?: string | null;
}

/** Where the items live. Swap the implementation to move them. */
export interface BacklogStorage {
  items(): BacklogItem[];
  add(input: AddInput): BacklogItem;
  start(
    id: string,
    input: { branch: string; repo?: string | null; by?: string | null },
  ): BacklogItem;
  drop(id: string, who?: string | null): BacklogItem;
  reopen(id: string, who?: string | null): BacklogItem;
  done(id: string, input?: { sha?: string | null; by?: string | null }): BacklogItem;
  assign(
    id: string,
    input: { session: string; branch?: string | null; by?: string | null },
  ): BacklogItem;
  claim(id: string, input: { agent: string; sid?: string | null; by?: string | null }): BacklogItem;
  hold(id: string, held: boolean, who?: string | null): BacklogItem;
  move(id: string, where: MoveTo, who?: string | null): BacklogItem;
  edit(id: string, input: EditInput, who?: string | null): BacklogItem;
}

/** Text with control characters out (a note keeps its newlines), trimmed, or an error when empty or too long. */
function clean(value: unknown, what: string, max: number, multiline = false): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (text.length > max) {
    throw new Error(`${what} is longer than ${max} characters`);
  }
  return text;
}

function optional(value: unknown, what: string, pattern: RegExp): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  if (!pattern.test(text)) {
    throw new Error(`${what} "${text.slice(0, 60)}" is not valid`);
  }
  return text;
}

/** The items in a file's text: the events folded by id, oldest first. Lines that aren't events are skipped. */
export function foldBacklog(text: string): BacklogItem[] {
  const items = new Map<string, BacklogItem>();
  // what each item was added with, which a reopen goes back to (a start overwrote the branch and the repo)
  const added = new Map<string, { branch: string | null; repo: string | null }>();
  const order: string[] = [];
  for (const line of text.split('\n')) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const id = typeof event?.id === 'string' ? event.id : '';
    if (!ID_PATTERN.test(id)) {
      continue;
    }
    const when = typeof event.at === 'string' ? event.at : '';
    const who = typeof event.by === 'string' ? event.by : 'cli';
    const found = items.get(id);
    if (event.op === 'add' && !found && typeof event.title === 'string') {
      order.push(id);
      added.set(id, {
        branch: typeof event.branch === 'string' && event.branch ? event.branch : null,
        repo: typeof event.repo === 'string' && event.repo ? event.repo : null,
      });
      items.set(id, {
        id,
        title: event.title,
        note: typeof event.note === 'string' && event.note ? event.note : null,
        repo: typeof event.repo === 'string' && event.repo ? event.repo : null,
        branch: typeof event.branch === 'string' && event.branch ? event.branch : null,
        added_by: who,
        added_at: when,
        state: 'open',
        started_at: null,
        started_by: null,
        dropped_at: null,
        landed_at: null,
        landed_sha: null,
        assigned: null,
        claim: null,
        hold: false,
      });
    } else if (
      found &&
      found.state !== 'dropped' &&
      event.op === 'start' &&
      typeof event.branch === 'string'
    ) {
      // (a start that landed after a drop, from a writer that read before it, doesn't bring the item back)
      found.state = 'started';
      found.branch = event.branch;
      found.repo = typeof event.repo === 'string' && event.repo ? event.repo : found.repo;
      found.started_at = when;
      found.started_by = who;
      // a new start is new work: an earlier landing no longer speaks for it
      found.landed_at = null;
      found.landed_sha = null;
    } else if (
      found &&
      found.state === 'open' &&
      event.op === 'assign' &&
      typeof event.session === 'string' &&
      SESSION_PATTERN.test(event.session)
    ) {
      found.assigned = {
        session: event.session,
        branch: typeof event.branch === 'string' && event.branch ? event.branch : null,
        at: when,
      };
    } else if (
      found &&
      (found.state === 'started' || found.state === 'open') &&
      event.op === 'done'
    ) {
      // (an open item an agent works on is started by what the board finds, so it can land with no `start`)
      found.landed_at = when;
      found.landed_sha = typeof event.sha === 'string' && event.sha ? event.sha : null;
    } else if (
      found &&
      found.state !== 'dropped' &&
      event.op === 'claim' &&
      typeof event.agent === 'string' &&
      AGENT_PATTERN.test(event.agent)
    ) {
      found.claim = {
        agent: event.agent,
        sid: typeof event.sid === 'string' && SID_PATTERN.test(event.sid) ? event.sid : null,
        by: who,
        at: when,
      };
    } else if (found && found.state !== 'dropped' && event.op === 'hold') {
      found.hold = event.on !== false;
    } else if (found && event.op === 'drop') {
      found.state = 'dropped';
      found.dropped_at = when;
    } else if (found && found.state === 'dropped' && event.op === 'reopen') {
      // back to an open item: the work it was started on no longer speaks for it, and it keeps its place in the order
      found.state = 'open';
      found.dropped_at = null;
      found.started_at = null;
      found.started_by = null;
      found.landed_at = null;
      found.landed_sha = null;
      found.branch = added.get(id)?.branch ?? null;
      found.repo = added.get(id)?.repo ?? null;
      found.assigned = null;
      found.claim = null;
      found.hold = false;
    } else if (found && found.state === 'open' && !found.landed_at && event.op === 'edit') {
      // only the fields the event carries change (a note or repo of '' clears it); a title is never blanked
      if (typeof event.title === 'string' && event.title) {
        found.title = event.title;
      }
      if (typeof event.note === 'string') {
        found.note = event.note || null;
      }
      if (typeof event.repo === 'string') {
        found.repo = event.repo || null;
        // a reopen goes back to the repo the item has now, not the one it was added with
        added.set(id, { branch: added.get(id)?.branch ?? null, repo: found.repo });
      }
    } else if (found && event.op === 'move') {
      // a target that is gone or unknown leaves the item where it was
      const target = typeof event.before === 'string' ? order.indexOf(event.before) : -1;
      if (event.edge === 'top' || event.edge === 'bottom' || (target >= 0 && event.before !== id)) {
        order.splice(order.indexOf(id), 1);
        let place = event.edge === 'top' ? 0 : order.length;
        if (!event.edge) {
          place = order.indexOf(event.before as string);
        }
        order.splice(place, 0, id);
      }
    }
  }
  return order.map((id) => items.get(id) as BacklogItem);
}

/** The items in <home>/backlog.jsonl. */
export class BacklogStore implements BacklogStorage {
  declare file: string;

  constructor(home: string) {
    this.file = path.join(home, 'backlog.jsonl');
  }

  items(): BacklogItem[] {
    return foldBacklog(readBacklogFile(this.file));
  }

  private append(event: Record<string, unknown>): void {
    appendBacklogEvent(this.file, event);
  }

  private find(id: string): BacklogItem {
    const item = this.items().find((one) => one.id === id);
    if (!item) {
      throw new Error(`no backlog item ${id}`);
    }
    return item;
  }

  add(input: AddInput): BacklogItem {
    const title = clean(input.title, 'the title', TITLE_MAX);
    if (!title) {
      throw new Error('a title is needed');
    }
    const id = newId('bl');
    this.append({
      op: 'add',
      id,
      title,
      note: clean(input.note, 'the note', NOTE_MAX, true) || null,
      repo: optional(input.repo, 'the repo', REPO_RE),
      branch: optional(input.branch, 'the branch', BRANCH_PATTERN),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  start(
    id: string,
    input: { branch: string; repo?: string | null; by?: string | null },
  ): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    const branch = optional(input.branch, 'the branch', BRANCH_PATTERN);
    if (!branch) {
      throw new Error('a branch is needed');
    }
    this.append({
      op: 'start',
      id,
      branch,
      repo: optional(input.repo, 'the repo', REPO_RE),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  /** Records that an Assign typed this item into a session (after the typing worked). */
  assign(
    id: string,
    input: { session: string; branch?: string | null; by?: string | null },
  ): BacklogItem {
    const item = this.find(id);
    if (item.state !== 'open') {
      throw new Error(`${id} is ${item.state}`);
    }
    if (!SESSION_PATTERN.test(input.session)) {
      throw new Error('a session id is needed');
    }
    this.append({
      op: 'assign',
      id,
      session: input.session,
      branch: optional(input.branch, 'the branch', BRANCH_PATTERN),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  /** Records that an agent owns the card: the board links the card to that agent and to nothing else. */
  claim(
    id: string,
    input: { agent: string; sid?: string | null; by?: string | null },
  ): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    const agent = optional(input.agent, 'the agent', AGENT_PATTERN);
    if (!agent) {
      throw new Error('an agent name is needed (--agent NAME, as the ledger names it)');
    }
    this.append({
      op: 'claim',
      id,
      agent,
      sid: optional(input.sid, 'the session id', SID_PATTERN),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  /** Marks the card as landing by hand (or clears that): a deploy leaves it open, `done ID` closes it. */
  hold(id: string, held: boolean, who?: string | null): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    this.append({ op: 'hold', id, on: held, by: clean(who, 'the name', BY_MAX) || 'cli' });
    return this.find(id);
  }

  move(id: string, where: MoveTo, who?: string | null): BacklogItem {
    this.find(id);
    const name = clean(who, 'the name', BY_MAX) || 'cli';
    if ('before' in where) {
      if (where.before === id || !this.items().some((one) => one.id === where.before)) {
        throw new Error(`no backlog item ${where.before} to put it before`);
      }
      this.append({ op: 'move', id, before: where.before, by: name });
    } else if (where.edge === 'top' || where.edge === 'bottom') {
      this.append({ op: 'move', id, edge: where.edge, by: name });
    } else {
      throw new Error('move it before another item, or to the top or bottom');
    }
    return this.find(id);
  }

  /**
   * Changes an open card's title, note or repo, appending only what differs from now (nothing appended when nothing does).
   * A started, done or dropped item is refused.
   */
  edit(id: string, input: EditInput, who?: string | null): BacklogItem {
    const item = this.find(id);
    if (item.state !== 'open' || item.landed_at) {
      throw new Error(
        `${id} is ${item.landed_at ? 'done' : item.state}, only an open card can be edited`,
      );
    }
    const changes: Record<string, string> = {};
    if (input.title !== undefined) {
      const title = clean(input.title, 'the title', TITLE_MAX);
      if (!title) {
        throw new Error('a title is needed');
      }
      if (title !== item.title) {
        changes.title = title;
      }
    }
    if (input.note !== undefined) {
      const note = clean(input.note, 'the note', NOTE_MAX, true);
      if (note !== (item.note ?? '')) {
        changes.note = note;
      }
    }
    if (input.repo !== undefined) {
      const repo = optional(input.repo, 'the repo', REPO_RE) ?? '';
      if (repo !== (item.repo ?? '')) {
        changes.repo = repo;
      }
    }
    if (Object.keys(changes).length) {
      this.append({ op: 'edit', id, ...changes, by: clean(who, 'the name', BY_MAX) || 'cli' });
    }
    return this.find(id);
  }

  /** Records that a started item's work landed (deploy-local.sh, no PR), with the sha it landed as when known. */
  done(id: string, input: { sha?: string | null; by?: string | null } = {}): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} is dropped, only a started or open item can be done`);
    }
    this.append({
      op: 'done',
      id,
      sha: optional(input.sha, 'the sha', SHA_PATTERN),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  drop(id: string, who?: string | null): BacklogItem {
    this.find(id);
    this.append({ op: 'drop', id, by: clean(who, 'the name', BY_MAX) || 'cli' });
    return this.find(id);
  }

  /** Brings a dropped item back as an open one, with the same id (so an id a ledger line names still means it). */
  reopen(id: string, who?: string | null): BacklogItem {
    const item = this.find(id);
    if (item.state !== 'dropped') {
      throw new Error(`${id} is ${item.state}, only a dropped item can be reopened`);
    }
    this.append({ op: 'reopen', id, by: clean(who, 'the name', BY_MAX) || 'cli' });
    return this.find(id);
  }
}

/** What to tell whoever takes a card: the board links a card to an agent only through its claim. */
export const claimHint = (id: string): string =>
  `Claim it first: once-upon backlog claim ${id} --agent NAME (the agent's name in the ledger), plus --branch BRANCH when it has one`;

/** The line a card shows for starting an item, to paste into a session. */
export const startLine = (item: Pick<BacklogItem, 'id' | 'branch'>): string =>
  `once-upon backlog start ${item.id} --branch ${item.branch || '<branch>'}`;

/** The assignment still in force: the item is open and the assign is under ASSIGN_HOURS old. */
export function liveAssignment(item: BacklogItem, nowMs: number): BacklogItem['assigned'] {
  const assignedMs = Date.parse(item.assigned?.at ?? '');
  if (item.state !== 'open' || !item.assigned || Number.isNaN(assignedMs)) {
    return null;
  }
  return nowMs - assignedMs > ASSIGN_HOURS * 3600 * 1000 ? null : item.assigned;
}

const TITLE_IN_LINE_MAX = 80;

/** A title safe to type: letters, digits, spaces and a little punctuation, collapsed, capped. Never anything that quotes or runs. */
export function lineTitle(title: string): string {
  const text = title
    .replace(/[^\p{L}\p{N} .,:()'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > TITLE_IN_LINE_MAX
    ? text.slice(0, TITLE_IN_LINE_MAX).trimEnd() + '...'
    : text;
}

/** The branch an Assign gives the work: the item's own, else backlog/<slug>-<first 4 of the id>. Always matches BRANCH_PATTERN. */
export function assignBranch(item: Pick<BacklogItem, 'id' | 'title' | 'branch'>): string {
  if (item.branch && BRANCH_PATTERN.test(item.branch)) {
    return item.branch;
  }
  const slug = item.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const tail = item.id.replace(/^bl_/, '').slice(0, 4);
  return `backlog/${slug ? `${slug}-` : ''}${tail}`;
}

/**
 * The message Assign sends the voice session: one line (Enter submits) with the id and a sanitized, capped title. The note and
 * the full title stay in the store; the session reads them with `once-upon backlog show <id>` when it starts the card.
 */
export function assignLine(item: Pick<BacklogItem, 'id' | 'title'>): string {
  const title = lineTitle(item.title);
  return `Start backlog card ${item.id}${title ? `: ${title}` : ''}. ${claimHint(item.id)}`;
}

/**
 * Whether a started item's work has landed or merged, with when: landed (`done`, a local deploy) is Done at that time,
 * merged is Done at its merge time (else the start). Null while the work is going on. What its agent says is `agentColumn`.
 */
function endedColumn(
  links: BoardStartedLinks | undefined,
  startedMs: number,
  landedMs: number,
): { column: 'done'; when: number } | null {
  if (!Number.isNaN(landedMs)) {
    return { column: 'done', when: landedMs };
  }
  if (links?.merged) {
    const when = Date.parse(links.merged_at ?? '');
    return { column: 'done', when: Number.isNaN(when) ? startedMs || 0 : when };
  }
  return null;
}

/** The repos whose finished work skips review for now and is Ready to ship (once-upon-a-diff and Larmor). */
const SKIPS_REVIEW = /^(once-upon-a-diff|larmor)$/i;

/**
 * Where an item goes by what its claimed ledger agent has produced (the agent has no card of its own: the item is the
 * one card):
 *
 *   open agent         a plan stop or a question is Waiting, for you; otherwise Working
 *   done, a branch     the work is not merged: Ready for review, or Ready to ship for once-upon-a-diff and Larmor
 *   done, card only    Done for DONE_HOURS after it ended, then off the board (it stays done, never back in Backlog)
 *   failed or stopped  back in Backlog, marked tried by the agent
 *
 * Null when the item is past its Done day. `tried` marks the Backlog case: the card says who tried it.
 */
function agentColumn(
  item: BacklogItem,
  agent: NonNullable<BoardStartedLinks['agent']>,
  nowMs: number,
): { column: BoardCard['column']; when: number | null; tried: boolean } | null {
  const ended = Date.parse(agent.ended_at ?? '');
  const when = Number.isNaN(ended) ? null : ended;
  if (agent.state === 'plan' || agent.state === 'waiting') {
    return { column: 'waiting', when, tried: false };
  }
  if (AGENT_OPEN.includes(agent.state)) {
    return { column: 'working', when, tried: false };
  }
  if (agent.state === 'failed' || agent.state === 'stopped') {
    return { column: 'backlog', when, tried: true };
  }
  if (item.state === 'started' && item.branch) {
    const repoName = (item.repo ?? '').split('/')[1] ?? '';
    return { column: SKIPS_REVIEW.test(repoName) ? 'ship' : 'ready', when, tried: false };
  }
  return when !== null && nowMs - when > DONE_HOURS * 3600 * 1000
    ? null
    : { column: 'done', when, tried: false };
}

const lane = (repo: string | null) => repo ?? 'General';

/** A live session that is on no card (the voice session, or one only listening): what a started item can sit on. */
export interface CardlessSession {
  repo: string | null;
  branch: string | null;
  /** how the card names it: "Voice session", or the session's title */
  label: string;
}

const AGENT_OPEN: BoardAgent['state'][] = ['running', 'waiting', 'plan', 'fixing'];

/** The card a started item rides on: the work card for its repo and branch, else a session card on it (a session on a new branch with no PR or story yet). */
export function cardOnBranch(
  item: Pick<BacklogItem, 'branch' | 'repo'>,
  cards: BoardCard[],
): BoardCard | undefined {
  const onBranch = (card: BoardCard, kind: BoardCard['kind']) =>
    card.kind === kind &&
    card.branch === item.branch &&
    (item.repo ? sameRepo(card.repo, item.repo) : !card.repo);
  return (
    cards.find((card) => onBranch(card, 'work')) ?? cards.find((card) => onBranch(card, 'session'))
  );
}

/**
 * The cards the Backlog item column shows, and the work cards' "from backlog" marks. Open items are cards in Backlog,
 * except one whose claimed agent is in the ledger (`once-upon backlog claim`, claims.ts), which goes where the agent's
 * work puts it (agentColumn). A started item is one piece of work, shown once:
 *
 *   on a card    it rides on the work or session card for its repo and branch, with its claimed agent's view in that card's
 *                `agents`; that card's column carries on
 *   no card      it is a card of its own in Working ("started, no session yet" until `links` (backlog-links.ts) finds a
 *                worktree, session or agent), in Done once its work merged or landed (`once-upon backlog done`), and gone
 *                DONE_HOURS after that. Its agent's work decides the rest (agentColumn): finished with a branch, it is
 *                Ready; failed or stopped, it is back in Backlog. An unlinked one is gone after STARTED_GRACE_HOURS
 *
 * A claimed card is one card: its claimed agent has no card of its own (stages/agents.ts holds it out) and shows on this
 * one, in `agents` (`views`, by item id). A claim whose agent has no ledger line yet is Working, marked pending, for
 * CLAIM_GRACE_HOURS. Dropped items are not shown.
 */
export function backlogCards(
  items: BacklogItem[],
  cards: BoardCard[],
  nowMs: number,
  cardless: CardlessSession[] = [],
  links: Map<string, BoardStartedLinks> = new Map(),
  views: Map<string, BoardAgent> = new Map(),
): BoardCard[] {
  const shown: BoardCard[] = [];
  for (const original of items) {
    if (original.state === 'dropped') {
      continue;
    }
    const link = links.get(original.id);
    // an open item that landed (`done` with no `start`) is a started one
    const derived = original.state === 'open' && !!original.landed_at;
    const item: BacklogItem = derived ? { ...original, state: 'started' } : original;
    let onSession: CardlessSession | undefined;
    let column: BoardCard['column'] = 'backlog';
    let since: string | null = item.added_at || null;
    let tried = false;
    const agent = link?.agent ?? null;
    const view = views.get(item.id);
    const claim = liveClaim(original, agent, nowMs);
    if (item.state === 'started' && item.branch) {
      const work = cardOnBranch(item, cards);
      if (work) {
        work.from_backlog = [...(work.from_backlog ?? []), { id: item.id, title: item.title }];
        if (view && !work.agents.some((one) => sameAgentView(one, view))) {
          work.agents.push(view);
        }
        if (work.kind === 'work' && !work.pr && !work.story) {
          work.title = item.title;
        }
        continue;
      }
    }
    if (agent && !(item.state === 'started' && (link?.merged || item.landed_at))) {
      // the claimed agent decides the column, whatever it is doing: Working while it runs, Waiting at a plan stop or a
      // question, then by what it produced (agentColumn)
      const placed = agentColumn(item, agent, nowMs);
      if (!placed) {
        continue;
      }
      column = placed.column;
      tried = placed.tried;
      since = item.started_at ?? item.added_at ?? null;
      if (column === 'backlog') {
        since = item.added_at || null;
      } else if (placed.when !== null) {
        since = new Date(placed.when).toISOString();
      }
    } else if (claim?.pending && item.state === 'open') {
      // claimed, and its agent's first ledger line has not landed yet
      column = 'working';
      since = claim.claim.at || since;
    }
    if (item.state === 'started') {
      onSession = cardless.find(
        (session) =>
          session.branch === item.branch &&
          (item.repo ? sameRepo(session.repo, item.repo) : !session.repo),
      );
      const started = Date.parse(item.started_at ?? '');
      const landed = endedColumn(link, started, Date.parse(item.landed_at ?? ''));
      if (landed) {
        // landed or merged: Done for a day from then, as far as is known
        if (nowMs - landed.when > DONE_HOURS * 3600 * 1000) {
          continue;
        }
        column = landed.column;
        tried = false;
        since = new Date(landed.when).toISOString();
      } else if (column === 'backlog' && !tried) {
        column = 'working';
        since = item.started_at || item.added_at || null;
        // work that is linked and not merged stays, whatever the day count says (a worktree, a session or its agent is on it)
        if (
          !onSession &&
          !link?.active &&
          (Number.isNaN(started) || nowMs - started > STARTED_GRACE_HOURS * 3600 * 1000)
        ) {
          continue;
        }
      }
    }
    shown.push({
      id: `backlog:${item.id}`,
      kind: 'backlog',
      title: item.title,
      repo: item.repo,
      branch: item.branch,
      lane: lane(item.repo),
      column,
      detail: item.note,
      since,
      pr: null,
      story: null,
      building: null,
      sessions: [],
      agents: view && column !== 'backlog' ? [view] : [],
      parent: null,
      focus_session: null,
      can_focus: false,
      listening: null,
      build: null,
      backlog: {
        id: item.id,
        added_by: item.added_by,
        started:
          item.state === 'started'
            ? {
                branch: item.branch,
                at: item.started_at,
                on: onSession?.label ?? null,
                links: links.get(item.id) ?? null,
              }
            : null,
        start_line: startLine(item),
        // an open item whose claimed agent is in the ledger: what is working it, or who tried it
        agent: original.state === 'open' && !derived && link?.agent ? { links: link, tried } : null,
        claim: claim
          ? { agent: claim.claim.agent, at: claim.claim.at || null, pending: claim.pending }
          : null,
        assigned:
          item.state === 'open' && liveAssignment(item, nowMs)
            ? {
                session: (item.assigned as NonNullable<BacklogItem['assigned']>).session,
                session_title: null,
                branch: item.assigned?.branch ?? null,
                at: item.assigned?.at ?? null,
              }
            : null,
        assign: null,
      },
    });
  }
  return shown;
}
