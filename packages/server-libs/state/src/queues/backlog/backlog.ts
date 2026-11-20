/**
 * The board's Backlog column: things to do later, kept by Once Upon in <home>/backlog.jsonl. One JSON event a line,
 * appended (never rewritten), so the CLI (in-process) and the bridge (page clicks) can both write without a lock, and
 * a drop is recoverable by hand. Everything goes through BacklogStore, so the file can be swapped for another store
 * without touching the board or the CLI.
 *
 * The format of each event is the contracts package's (contracts/src/files/schemas.ts); this lists them for the fold:
 *
 *   {op:'add',   id, title, note, repo, branch, source?, worktree?, pr?, story?, session?, by, at}   `source` (ADR-29): what made the card, `backlog` when absent
 *   {op:'start', id, branch, repo, by, at}     work began on that branch
 *   {op:'link',  id, repo?, branch?, worktree?, pr?, story?, session?, source?, by, at}   a fact learned about the card, written once onto it. Sets only the
 *                                              fields it carries, on a card that is not dropped or landed; never touches the state, `started_at`, `landed_*`,
 *                                              the claim or `someday`. `source` only as `backlog`: `backlog adopt` lists a card an agent made
 *   {op:'done',  id, sha?, merged_at?, by, at} the work landed (`merged_at`: when its PR merged, so `landed_at` is that time; a local deploy, or the bridge seeing the card's PR merge: land-merged.ts); an open item can land too
 *   {op:'drop',  id, by, at}
 *   {op:'reopen', id, by, at}                  a dropped item is open again (a new `start` after a drop is still ignored)
 *   {op:'move',  id, before | edge, by, at}   `before` is another item's id; `edge` is 'top' or 'bottom'
 *   {op:'edit',  id, title?, note?, repo?, story?, by, at}   only the fields that changed; an empty note, repo or story clears it. An open item only; a started one takes the story alone
 *   {op:'claim', id, agent, sid?, session?, worktree?, by, at}   an agent (named as it registered) owns the card: the one link from a card to an
 *                                              agent (claims.ts). The latest claim wins; a `done` or a reopen clears it. `session` is the
 *                                              claimer's full session id (the editor's: slots.ts) and `worktree` the checkout path
 *   {op:'hold',  id, on, by, at}              the card lands by hand: a deploy or a merged PR never marks it done (landing.ts, land-merged.ts), only `done ID` does.
 *                                              `on:false` clears it; a reopen clears it too. Sticky across claims
 *   {op:'skip_critic', id, on, by, at}        the card's critic is skipped by hand: a built card with no passing critic reads Ready (phase.ts row 5)
 *                                              instead of Waiting. `on:false` clears it; a reopen clears it too
 *   {op:'someday', id, on, by, at}            maybe someday: an open card with no live claim leaves the main list for the Someday section,
 *                                              keeping its place in the order (`on:false` puts it back there). A start, a claim, a done,
 *                                              a drop or a reopen clears it: work on the card brings it back
 *
 * The items come back in order: an add goes to the bottom, and a move puts one item before another or at an edge.
 * A move names where it goes relative to the other items, never an index, so it folds the same whatever was added or
 * dropped in between, and the page shows the order within each repo lane.
 *
 * An open item is a card in the Backlog column, in its repo's lane. A started item leaves the column and is one piece of
 * work shown once: it rides on the card its work is on (the work card for its repo and branch: "from backlog"), or, with
 * no card, is a card of its own: in Backlog until a run, a session or a landing says more, then in Done once it merged,
 * landed or its agent finished. That is worked out on read, so a board snapshot never writes.
 */
import {
  BACKLOG_ID_RE,
  AGENT_NAME_RE,
  CARD_BRANCH_RE,
  SESSION_RE,
  SID_RE,
  STORY_ID_RE,
} from '@once-upon-a-diff/terms/patterns';
import { canonicalRepo } from '@once-upon-a-diff/terms/ids';
import { CARD_SOURCES, readBacklogEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { strictBacklogEvent } from '@once-upon-a-diff/contracts/files/strict';
import { checkWrite } from '@once-upon-a-diff/foundation/shared-files';
import { BACKLOG_NOTE_MAX, SHA_RE } from '@once-upon-a-diff/terms/text';
import { jsonLines } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { tailLog } from '@once-upon-a-diff/adapters/stores/fs/tail-log';
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { appendBacklogEvent } from '@once-upon-a-diff/adapters/stores/backlog-file';
import path from 'node:path';
import { OPEN, liveClaim, sameAgentView } from './claims.ts';
import { DONE_HOURS, workAgent, type CardPhase } from './phase.ts';
import { REPO_RE, sameRepo } from '@once-upon-a-diff/foundation/repos';
import { newId } from '@once-upon-a-diff/foundation/ids';
import { clean, count, optional } from '@once-upon-a-diff/foundation/input';
import type { BoardAgent, BoardCard, BoardStartedLinks } from '@once-upon-a-diff/contracts/types';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import type { CardLookup } from '../../records/agents/registry.ts';
import type { BacklogItem, CardSource } from './types.ts';

export { DONE_HOURS };

const TITLE_MAX = 200;
const NOTE_MAX = BACKLOG_NOTE_MAX; // long enough for a plan or a repro: the CLI takes one from a file or stdin
const BY_MAX = 40;

/** Where a move puts an item: before another one, or at the top or the bottom. */
export type MoveTo = { before: string } | { edge: 'top' | 'bottom' };

/** What an edit changes: a field left out (undefined) stays; an empty note or repo clears it. */
export interface EditInput {
  title?: string;
  note?: string | null;
  repo?: string | null;
  story?: string | null;
}

/** What a claim records: the agent, and who claimed it (its first 8 and full session) and where the work is, when known. */
export interface ClaimInput {
  agent: string;
  sid?: string | null;
  session?: string | null;
  worktree?: string | null;
  by?: string | null;
}

export interface AddInput {
  /** an implicit card's id, kept when it is adopted (`backlog adopt`); a fresh `bl_` id when left out */
  id?: string;
  title: string;
  note?: string | null;
  repo?: string | null;
  branch?: string | null;
  by?: string | null;
  /** what made the card (ADR-29); `backlog` when left out */
  source?: CardSource;
  worktree?: string | null;
  pr?: number | null;
  story?: string | null;
  session?: string | null;
  /** when the card was first made, as an ISO time in the past (a backfilled card's: its first run's start); now when left out */
  at?: string | null;
}

/** The facts a `link` writes onto a card (ADR-29): the ones it carries are set, the rest stay. */
export interface LinkInput {
  repo?: string | null;
  branch?: string | null;
  worktree?: string | null;
  pr?: number | null;
  story?: string | null;
  session?: string | null;
  /** only `backlog`: lists a card an agent made (`backlog adopt`) */
  source?: 'backlog';
  by?: string | null;
}

/**
 * Whether the Backlog column, the lists and the checks that decide what a card IS see it: a card someone added (or an agent's,
 * once adopted). The cards the first fact about some work made (`source` agent, session, pr, story) are stored and found by id,
 * and shown by nothing until the board reads them (ADR-29).
 */
export const isListed = (item: Pick<BacklogItem, 'source'>): boolean =>
  (item.source ?? 'backlog') === 'backlog';

/** Where the items live. Swap the implementation to move them. */
export interface BacklogStorage {
  items(): BacklogItem[];
  listed(): BacklogItem[];
  add(input: AddInput): BacklogItem;
  link(id: string, input: LinkInput): BacklogItem;
  adopt(
    id: string,
    input?: { title?: string | null; note?: string | null; by?: string | null },
  ): BacklogItem;
  start(
    id: string,
    input: { branch: string; repo?: string | null; by?: string | null },
  ): BacklogItem;
  drop(id: string, who?: string | null): BacklogItem;
  reopen(id: string, who?: string | null): BacklogItem;
  done(id: string, input?: { sha?: string | null; by?: string | null }): BacklogItem;
  claim(id: string, input: ClaimInput): BacklogItem;
  hold(id: string, held: boolean, who?: string | null): BacklogItem;
  skipCritic(id: string, skipped: boolean, who?: string | null): BacklogItem;
  someday(
    id: string,
    aside: boolean,
    who?: string | null,
    agents?: LedgerAgent[],
    nowMs?: number,
  ): BacklogItem;
  move(id: string, where: MoveTo, who?: string | null): BacklogItem;
  edit(id: string, input: EditInput, who?: string | null): BacklogItem;
}

type BacklogEvent = NonNullable<ReturnType<typeof readBacklogEvent>>;

/** The events in a file's text, in order. Lines that aren't events are skipped. */
const parseBacklogEvents = (text: string): BacklogEvent[] =>
  jsonLines(text).flatMap((value) => readBacklogEvent(value) ?? []);

/** The events in backlog.jsonl, read once and then only as far as the file has grown (`tailLog`). The fold reads them and never changes one. */
export const backlogEventsIn = tailLog(parseBacklogEvents);

/** The items in a file's text: the events folded by id, oldest first. Lines that aren't events are skipped. */
export const foldBacklog = (text: string): BacklogItem[] =>
  foldBacklogEvents(parseBacklogEvents(text));

/** The items the events fold to, by id, oldest first. */
export function foldBacklogEvents(events: BacklogEvent[]): BacklogItem[] {
  const items = new Map<string, BacklogItem>();
  // what each item was added with, which a reopen goes back to (a start overwrote the branch and the repo)
  const added = new Map<string, { branch: string | null; repo: string | null }>();
  // when each item was last reopened, put on hold and set aside, which `parked_at` reads
  const marks = new Map<string, { reopened?: string; hold?: string; someday?: string }>();
  const order: string[] = [];
  for (const event of events) {
    const id = event.id;
    const when = event.at ?? '';
    const who = event.by ?? 'cli';
    const found = items.get(id);
    if (event.op === 'add' && !found) {
      order.push(id);
      added.set(id, { branch: event.branch || null, repo: event.repo || null });
      items.set(id, {
        id,
        title: event.title,
        note: event.note || null,
        repo: event.repo || null,
        branch: event.branch || null,
        added_by: who,
        added_at: when,
        state: 'open',
        source: event.source ?? 'backlog',
        worktree: event.worktree || null,
        pr: event.pr || null,
        story: event.story || null,
        session: event.session || null,
        started_at: null,
        started_by: null,
        dropped_at: null,
        landed_at: null,
        landed_sha: null,
        claim: null,
        hold: false,
        critic_skipped: false,
        someday: false,
      });
    } else if (found && found.state !== 'dropped' && event.op === 'start') {
      // (a start that landed after a drop, from a writer that read before it, doesn't bring the item back)
      // a start on a card already started and not landed is the same work on another branch (`backlog branch`): who started
      // it and when stand, as the board's elapsed time reads them
      const sameWork = found.state === 'started' && !found.landed_at && !!found.started_at;
      found.state = 'started';
      found.branch = event.branch;
      found.repo = event.repo || found.repo;
      if (!sameWork) {
        found.started_at = when;
        found.started_by = who;
      }
      // a new start is new work: an earlier landing no longer speaks for it
      found.landed_at = null;
      found.landed_sha = null;
      found.someday = false;
    } else if (
      found &&
      (found.state === 'started' || found.state === 'open') &&
      event.op === 'done'
    ) {
      // (an open item an agent works on is started by what the board finds, so it can land with no `start`)
      found.landed_at = event.merged_at || when;
      found.landed_sha = event.sha || null;
      // the claim ends when the card lands, whatever its agent is doing. A later claim is recorded, but holds nothing
      // until a `start` reopens the work (liveClaim ignores a landed card)
      found.claim = null;
      found.someday = false;
    } else if (found && found.state !== 'dropped' && !found.landed_at && event.op === 'link') {
      // a fact learned about the work: only the fields the event carries are set, nothing else about the card moves
      found.repo = event.repo || found.repo;
      found.branch = event.branch || found.branch;
      found.worktree = event.worktree || found.worktree;
      found.pr = event.pr || found.pr;
      found.story = event.story || found.story;
      found.session = event.session || found.session;
      found.source = event.source ?? found.source;
    } else if (found && found.state !== 'dropped' && event.op === 'claim') {
      // (the claim's checkout is the card's until a `link` says another)
      found.worktree ??= event.worktree || null;
      found.claim = {
        agent: event.agent,
        sid: event.sid ?? null,
        session: event.session ?? null,
        worktree: event.worktree ?? null,
        by: who,
        at: when,
      };
      found.someday = false;
    } else if (found && found.state !== 'dropped' && event.op === 'hold') {
      found.hold = event.on !== false;
      marks.set(id, { ...marks.get(id), hold: found.hold ? when : undefined });
    } else if (found && found.state !== 'dropped' && event.op === 'skip_critic') {
      found.critic_skipped = event.on !== false;
    } else if (found && found.state === 'open' && !found.landed_at && event.op === 'someday') {
      found.someday = event.on !== false;
      marks.set(id, { ...marks.get(id), someday: found.someday ? when : undefined });
    } else if (found && event.op === 'drop') {
      found.state = 'dropped';
      found.dropped_at = when;
      found.someday = false;
    } else if (found && found.state === 'dropped' && event.op === 'reopen') {
      // back to an open item: the work it was started on no longer speaks for it, and it keeps its place in the order
      found.state = 'open';
      found.dropped_at = null;
      marks.set(id, { ...marks.get(id), reopened: when, hold: undefined, someday: undefined });
      found.started_at = null;
      found.started_by = null;
      found.landed_at = null;
      found.landed_sha = null;
      found.branch = added.get(id)?.branch ?? null;
      found.repo = added.get(id)?.repo ?? null;
      found.claim = null;
      found.hold = false;
      found.critic_skipped = false;
      found.someday = false;
    } else if (
      found &&
      (found.state === 'open' || found.state === 'started') &&
      !found.landed_at &&
      event.op === 'edit'
    ) {
      // only the fields the event carries change (a note or repo of '' clears it); a title is never blanked.
      // A started card takes the story only: its title, note and repo stay what its work began with
      const open = found.state === 'open';
      if (open && event.title) {
        found.title = event.title;
      }
      if (open && typeof event.note === 'string') {
        found.note = event.note || null;
      }
      if (open && typeof event.repo === 'string') {
        found.repo = event.repo || null;
        // a reopen goes back to the repo the item has now, not the one it was added with
        added.set(id, { branch: added.get(id)?.branch ?? null, repo: found.repo });
      }
      if (typeof event.story === 'string') {
        found.story = event.story || null;
      }
    } else if (found && event.op === 'move') {
      // a target that is gone or unknown leaves the item where it was
      const target = event.before ? order.indexOf(event.before) : -1;
      if (event.edge || (target >= 0 && event.before !== id)) {
        order.splice(order.indexOf(id), 1);
        let place = event.edge === 'top' ? 0 : order.length;
        if (!event.edge) {
          place = order.indexOf(event.before as string);
        }
        order.splice(place, 0, id);
      }
    }
  }
  for (const [id, mark] of marks) {
    const item = items.get(id) as BacklogItem;
    // a mark counts while it stands: a start or a claim ends someday, and hold or someday off end theirs
    const times = [
      mark.reopened,
      item.hold ? mark.hold : undefined,
      item.someday ? mark.someday : undefined,
    ]
      .filter((time): time is string => !!time)
      .sort();
    item.parked_at = times.length ? times[times.length - 1] : null;
  }
  return order.map((id) => items.get(id) as BacklogItem);
}

const cardSource = (value: string): CardSource => {
  if (!(CARD_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`the source must be one of ${CARD_SOURCES.join(', ')}`);
  }
  return value as CardSource;
};

/** An ISO time that is not in the future, as written. */
function pastTime(value: string): string {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) || !Number.isFinite(time)) {
    throw new Error('the time must be an ISO date (2026-11-18T12:00:00.000Z)');
  }
  if (time > Date.now()) {
    throw new Error('the time cannot be in the future');
  }
  return new Date(time).toISOString();
}

/** The checked worktree, PR, story and session of an add or a link: only the ones given (a null or empty one is left out). */
function cardFacts(input: {
  worktree?: string | null;
  pr?: number | null;
  story?: string | null;
  session?: string | null;
}): { worktree?: string; pr?: number; story?: string; session?: string } {
  const worktree = clean(input.worktree, 'the worktree', 500);
  if (worktree && !path.isAbsolute(worktree)) {
    throw new Error('the worktree must be an absolute path');
  }
  const pr = count(input.pr, 'the PR number');
  const story = optional(input.story, 'the story', STORY_ID_RE);
  const session = optional(input.session, 'the session', SESSION_RE);
  return {
    ...(worktree ? { worktree } : {}),
    ...(pr ? { pr } : {}),
    ...(story ? { story } : {}),
    ...(session ? { session } : {}),
  };
}

/** The items in <home>/backlog.jsonl. */
export class BacklogStore implements BacklogStorage {
  declare file: string;

  constructor(home: string) {
    this.file = path.join(home, 'backlog.jsonl');
  }

  items(): BacklogItem[] {
    return foldBacklogEvents(backlogEventsIn(this.file));
  }

  /** The listed items (isListed): what the board and the lists show. `items()` is every stored card, for finding one by its id. */
  listed(): BacklogItem[] {
    return this.items().filter(isListed);
  }

  private append(event: Record<string, unknown>, stamp: string = new Date().toISOString()): void {
    // the line is stamped with its time as it is appended (`at` is a backfilled card's own); the check sees the same
    checkWrite(this.file, { ...event, at: stamp }, readBacklogEvent, strictBacklogEvent);
    appendBacklogEvent(this.file, event, stamp);
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
    const id = optional(input.id, 'the id', BACKLOG_ID_RE) ?? newId('bl');
    if (input.id && this.items().some((one) => one.id === id)) {
      throw new Error(`${id} is already a card`);
    }
    this.append(
      {
        op: 'add',
        id,
        title,
        note: clean(input.note, 'the note', NOTE_MAX, true) || null,
        repo: optional(input.repo, 'the repo', REPO_RE),
        branch: optional(input.branch, 'the branch', CARD_BRANCH_RE),
        by: clean(input.by, 'the name', BY_MAX) || 'cli',
        ...cardFacts(input),
        ...(input.source && input.source !== 'backlog' ? { source: cardSource(input.source) } : {}),
      },
      input.at ? pastTime(input.at) : undefined,
    );
    return this.find(id);
  }

  /**
   * Writes facts learned about a card onto it (ADR-29), only the ones that differ from what it has (nothing is appended when
   * none does). A card that is dropped or landed takes none: the item comes back as it was.
   */
  link(id: string, input: LinkInput): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped' || item.landed_at) {
      return item;
    }
    const facts = cardFacts(input);
    const repo = optional(input.repo, 'the repo', REPO_RE);
    const branch = optional(input.branch, 'the branch', CARD_BRANCH_RE);
    const changes: Record<string, unknown> = {
      ...(repo && repo !== item.repo ? { repo } : {}),
      ...(branch && branch !== item.branch ? { branch } : {}),
      ...(facts.worktree && facts.worktree !== item.worktree ? { worktree: facts.worktree } : {}),
      ...(facts.pr && facts.pr !== item.pr ? { pr: facts.pr } : {}),
      ...(facts.story && facts.story !== item.story ? { story: facts.story } : {}),
      ...(facts.session && facts.session !== item.session ? { session: facts.session } : {}),
      ...(input.source === 'backlog' && !isListed(item) ? { source: 'backlog' } : {}),
    };
    if (Object.keys(changes).length) {
      this.append({ op: 'link', id, ...changes, by: clean(input.by, 'the name', BY_MAX) || 'cli' });
    }
    return this.find(id);
  }

  /**
   * Lists a stored card an agent made (`backlog adopt`): its source becomes `backlog`, with the title and note typed when given.
   * One step under the file's lock.
   */
  adopt(
    id: string,
    input: { title?: string | null; note?: string | null; by?: string | null } = {},
  ): BacklogItem {
    return withLock(this.file, () => {
      const item = this.find(id);
      if (isListed(item)) {
        throw new Error(`${id} is already a card`);
      }
      this.link(id, { source: 'backlog', by: input.by });
      const changes = {
        ...(input.title ? { title: input.title } : {}),
        ...(input.note ? { note: input.note } : {}),
      };
      return Object.keys(changes).length ? this.edit(id, changes, input.by) : this.find(id);
    });
  }

  start(
    id: string,
    input: { branch: string; repo?: string | null; by?: string | null },
  ): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    const branch = optional(input.branch, 'the branch', CARD_BRANCH_RE);
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

  /**
   * Records that an agent owns the card: the board links the card to that agent and to nothing else. The check and the
   * append run under the log's lock, so claims take turns; the latest claim wins either way, and nothing more is promised.
   */
  claim(id: string, input: ClaimInput): BacklogItem {
    return withLock(this.file, () => this.claimLocked(id, input));
  }

  private claimLocked(id: string, input: ClaimInput): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    const agent = optional(input.agent, 'the agent', AGENT_NAME_RE);
    if (!agent) {
      throw new Error('an agent name is needed (--agent NAME, as the ledger names it)');
    }
    this.append({
      op: 'claim',
      id,
      agent,
      sid: optional(input.sid, 'the session id', SID_RE),
      session: optional(input.session, 'the session', SESSION_RE),
      worktree: clean(input.worktree, 'the worktree', 500) || null,
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

  /** Records that the card's critic is skipped (or clears that): a built card with no passing critic is then Ready, not Waiting. */
  skipCritic(id: string, skipped: boolean, who?: string | null): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} was dropped`);
    }
    this.append({
      op: 'skip_critic',
      id,
      on: skipped,
      by: clean(who, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  /**
   * Puts an open card in the Someday section (or back in the main list, in its old place). Refused for a started, done or
   * dropped card, and for one whose claim is live (its agent's run is open, or it was just given the card): `agents` is the registry's.
   */
  someday(
    id: string,
    aside: boolean,
    who?: string | null,
    agents: LedgerAgent[] = [],
    nowMs: number = Date.now(),
  ): BacklogItem {
    const item = this.find(id);
    if (aside && (item.state !== 'open' || item.landed_at)) {
      throw new Error(
        `${id} is ${item.landed_at ? 'done' : item.state}, only an open card can be someday`,
      );
    }
    // live: its run is open, or it was just made and the agent's first line has not landed (a finished run's card is free)
    const run = workAgent(item, agents);
    if (aside && (run ? OPEN.includes(run.state) : liveClaim(item, null, nowMs))) {
      throw new Error(
        `${id} is claimed by ${item.claim?.agent}, who is working it: it can be someday once that run is over`,
      );
    }
    this.append({ op: 'someday', id, on: aside, by: clean(who, 'the name', BY_MAX) || 'cli' });
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
   * A started, done or dropped item is refused, except that a started card that has not landed takes its story (a repair).
   */
  edit(id: string, input: EditInput, who?: string | null): BacklogItem {
    const item = this.find(id);
    const storyOnly =
      input.title === undefined && input.note === undefined && input.repo === undefined;
    const editable = item.state === 'open' || (item.state === 'started' && storyOnly);
    if (!editable || item.landed_at) {
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
    if (input.story !== undefined) {
      const story = optional(input.story, 'the story', STORY_ID_RE) ?? '';
      if (story !== (item.story ?? '')) {
        changes.story = story;
      }
    }
    if (Object.keys(changes).length) {
      this.append({ op: 'edit', id, ...changes, by: clean(who, 'the name', BY_MAX) || 'cli' });
    }
    return this.find(id);
  }

  /** Records that a started item's work landed (deploy-local.sh, or the board seeing its PR merge), with the sha it landed as when known. */
  done(id: string, input: { sha?: string | null; by?: string | null } = {}): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} is dropped, only a started or open item can be done`);
    }
    this.append({
      op: 'done',
      id,
      sha: optional(input.sha, 'the sha', SHA_RE),
      by: clean(input.by, 'the name', BY_MAX) || 'cli',
    });
    return this.find(id);
  }

  drop(id: string, who?: string | null): BacklogItem {
    this.find(id);
    this.append({ op: 'drop', id, by: clean(who, 'the name', BY_MAX) || 'cli' });
    return this.find(id);
  }

  /** Brings a dropped item back as an open one, with the same id (so an id a registry event or a log line names still means it). */
  reopen(id: string, who?: string | null): BacklogItem {
    const item = this.find(id);
    if (item.state !== 'dropped') {
      throw new Error(`${id} is ${item.state}, only a dropped item can be reopened`);
    }
    this.append({ op: 'reopen', id, by: clean(who, 'the name', BY_MAX) || 'cli' });
    return this.find(id);
  }
}

/** The registry's view of the cards (registry.ts's CardLookup): a run that names a card is checked against it. */
export const cardLookup =
  (store: Pick<BacklogStore, 'items'>): CardLookup =>
  (id) => {
    const item = store.items().find((one) => one.id === id);
    let closed: 'dropped' | 'landed' | null = null;
    if (item?.state === 'dropped') {
      closed = 'dropped';
    } else if (item?.landed_at) {
      closed = 'landed';
    }
    return item
      ? {
          id,
          closed,
          repo: item.repo,
          branch: item.branch,
          // a card an agent or a session made has no claim row: its first run's session holds it, as an implicit card's does
          claimed: !!item.claim || !isListed(item),
          worktree: item.worktree,
          agentMade: item.source === 'agent',
        }
      : null;
  };

/** What to tell whoever takes a card: the claim says who took it, and comes before the agent's start. */
export const claimHint = (id: string): string =>
  `Claim it first: once-upon backlog claim ${id} --agent NAME (the agent's name in the ledger), plus --branch BRANCH when it has one`;

/** The line a card shows for starting an item, to paste into a session. */
export const startLine = (item: Pick<BacklogItem, 'id' | 'branch'>): string =>
  `once-upon backlog start ${item.id} --branch ${item.branch || '<branch>'}`;

/**
 * Whether a started item's work has landed or merged, with when: landed (`done`, a local deploy) is Done at that time,
 * merged is Done at its merge time (else the start). Null while the work is going on. What its runs say is `cardPhase`.
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

const lane = (repo: string | null) => canonicalRepo(repo) ?? 'General';

/**
 * The card a started item rides on: the work card of its PR (by number, so a PR whose head was renamed keeps its card), else the work
 * card for its repo and branch, else a session card on it (a session on a new branch with no PR or story yet).
 */
export function cardOnBranch(
  item: Pick<BacklogItem, 'branch' | 'repo'> & Partial<Pick<BacklogItem, 'pr'>>,
  cards: BoardCard[],
): BoardCard | undefined {
  const ofPr =
    item.pr && item.repo
      ? cards.find(
          (card) =>
            card.kind === 'work' && card.pr?.number === item.pr && sameRepo(card.repo, item.repo),
        )
      : undefined;
  if (ofPr) {
    return ofPr;
  }
  const onBranch = (card: BoardCard, kind: BoardCard['kind']) =>
    card.kind === kind &&
    card.branch === item.branch &&
    (item.repo ? sameRepo(card.repo, item.repo) : !card.repo);
  return (
    cards.find((card) => onBranch(card, 'work')) ?? cards.find((card) => onBranch(card, 'session'))
  );
}

/** A started item that rides on a card: the card carries its "from backlog" mark and its runs' views, and a work card with no PR or story is titled by the item. */
export function mergeIntoWork(
  work: BoardCard,
  item: Pick<BacklogItem, 'id' | 'title'>,
  views: BoardAgent[],
): void {
  work.from_backlog = [...(work.from_backlog ?? []), { id: item.id, title: item.title }];
  for (const view of views) {
    if (!work.agents.some((one) => sameAgentView(one, view))) {
      work.agents.push(view);
    }
  }
  if (work.kind === 'work' && !work.pr && !work.story) {
    work.title = item.title;
  }
}

/**
 * The cards the Backlog item column shows, and the work cards' "from backlog" marks. Open items are cards in Backlog,
 * except one a work run names (`agent start --card`), which goes where its runs put it (`cardPhase`, phase.ts). A started item is one piece of work, shown once:
 *
 *   on a card    it rides on the work or session card for its repo and branch, with its runs' views in that card's
 *                `agents`; that card's column carries on
 *   no card      it is a card of its own: in Backlog ("started, no session yet" until `links` (backlog-links.ts) finds a
 *                worktree, session or agent) while no run, session or landing says more, in Done once its work merged or
 *                landed (`once-upon backlog done`), and gone DONE_HOURS after that. Its runs decide the rest (`cardPhase`):
 *                finished with a branch, it is Ready; failed or stopped, it is back in Backlog
 *
 * A card is one card: the agents whose runs name it have no card of their own (stages/agents.ts holds them out) and show on
 * this one, in `agents` (`views`, by item id). A claim no run names yet is Working, marked pending, for CLAIM_GRACE_HOURS.
 * Dropped items are not shown.
 */
export function backlogCards(
  items: BacklogItem[],
  cards: BoardCard[],
  nowMs: number,
  links: Map<string, BoardStartedLinks> = new Map(),
  views: Map<string, BoardAgent[]> = new Map(),
  phases: Map<string, CardPhase | null> = new Map(),
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
    let column: BoardCard['column'] = 'backlog';
    let since: string | null = item.added_at || null;
    let tried = false;
    let outside: CardPhase['outside'];
    const agent = link?.agent ?? null;
    const itemViews = views.get(item.id) ?? [];
    const claim = liveClaim(original, agent, nowMs);
    if (item.state === 'started' && item.branch) {
      const work = cardOnBranch(item, cards);
      if (work) {
        mergeIntoWork(work, item, itemViews);
        continue;
      }
    }
    if (phases.has(item.id) && !(item.state === 'started' && (link?.merged || item.landed_at))) {
      // the card's runs decide the column (cardPhase): Working while the author runs, Agent checks at a plan stop, Waiting at
      // a question, then by what it produced
      const placed = phases.get(item.id);
      if (!placed) {
        continue;
      }
      column = placed.column;
      tried = placed.tried;
      outside = placed.outside;
      since = item.started_at ?? item.added_at ?? null;
      if (column === 'backlog') {
        since = item.added_at || null;
      } else if (placed.when !== null) {
        since = new Date(placed.when).toISOString();
      }
    } else if (claim?.pending && (item.state === 'open' || item.state === 'started')) {
      // claimed (`backlog claim --branch` starts the card too), and its agent's first event has not landed yet
      column = 'working';
      since = claim.claim.at || since;
    }
    if (item.state === 'started') {
      const started = Date.parse(item.started_at ?? '');
      const landed = endedColumn(link, started, Date.parse(item.landed_at ?? ''));
      if (landed) {
        // landed or merged: Done for DONE_HOURS from then, as far as is known
        if (nowMs - landed.when > DONE_HOURS * 3600 * 1000) {
          continue;
        }
        column = landed.column;
        tried = false;
        since = new Date(landed.when).toISOString();
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
      // a started card no work run names keeps its other runs (a critic, a helper) in view; a card sent back or parked shows none
      agents:
        column === 'backlog' && (item.state !== 'started' || phases.has(item.id)) ? [] : itemViews,
      parent: null,
      focus_session: null,
      can_focus: false,
      listening: null,
      build: null,
      ...(outside && item.repo && item.branch && column === 'working'
        ? {
            outside: { sha: outside.tip, branch: item.branch, repo: item.repo, path: outside.path },
          }
        : {}),
      backlog: {
        id: item.id,
        added_by: item.added_by,
        started:
          item.state === 'started'
            ? {
                branch: item.branch,
                at: item.started_at,
                on: null,
                links: links.get(item.id) ?? null,
              }
            : null,
        ...(item.someday && item.state === 'open' && column === 'backlog'
          ? { someday: true as const }
          : {}),
        start_line: startLine(item),
        // an open item whose claimed agent is in the registry: what is working it, or who tried it
        agent: original.state === 'open' && !derived && link?.agent ? { links: link, tried } : null,
        claim: claim
          ? { agent: claim.claim.agent, at: claim.claim.at || null, pending: claim.pending }
          : null,
      },
    });
  }
  return shown;
}
