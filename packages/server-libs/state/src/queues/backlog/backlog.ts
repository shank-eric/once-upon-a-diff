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
 *                                              or `someday`. `source` only as `backlog`: `backlog adopt` lists a card an agent made
 *   {op:'done',  id, sha?, merged_at?, by, at} the work landed (`merged_at`: when its PR merged, so `landed_at` is that time; a local deploy, or the bridge seeing the card's PR merge: land-merged.ts); an open item can land too
 *   {op:'drop',  id, by, at}
 *   {op:'reopen', id, by, at}                  a dropped item is open again (a new `start` after a drop is still ignored)
 *   {op:'move',  id, before | edge, by, at}   `before` is another item's id; `edge` is 'top' or 'bottom'
 *   {op:'edit',  id, title?, note?, repo?, story?, by, at}   only the fields that changed; an empty note, repo or story clears it. An open item only; a started one takes the story alone
 *   {op:'claim', id, agent, sid?, session?, worktree?, by, at}   retired (ADR-29: a card's runs say who works it): nothing writes it now, an old row is read for
 *                                              its `worktree` (the card's checkout until a `link` says another) and ends someday
 *   {op:'hold',  id, on, by, at}              the card lands by hand: a deploy or a merged PR never marks it done (landing.ts, land-merged.ts), only `done ID` does.
 *                                              `on:false` clears it; a reopen clears it too
 *   {op:'skip_critic', id, on, by, at}        the card's critic is skipped by hand: a built card with no passing critic reads Ready (phase.ts row 5)
 *                                              instead of Waiting. `on:false` clears it; a reopen clears it too
 *   {op:'someday', id, on, by, at}            maybe someday: an open card nobody is working leaves the main list for the Someday section,
 *                                              keeping its place in the order (`on:false` puts it back there). A start, a done,
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
  CARD_BRANCH_RE,
  SESSION_RE,
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
import { OPEN, sameAgentView } from './claims.ts';
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

/** What a landing carries: the sha it landed as, who recorded it, and when GitHub merged it (a merge-landed card's own time). */
export interface DoneInput {
  sha?: string | null;
  by?: string | null;
  mergedAt?: string | null;
}

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
  done(id: string, input?: DoneInput): BacklogItem;
  hold(id: string, held: boolean, who?: string | null): BacklogItem;
  skipCritic(id: string, skipped: boolean, who?: string | null): BacklogItem;
  someday(id: string, aside: boolean, who?: string | null, agents?: LedgerAgent[]): BacklogItem;
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

interface BacklogMarks {
  reopened?: string;
  hold?: string;
  someday?: string;
}

/** What the fold keeps while it reads the events. */
interface BacklogFold {
  items: Map<string, BacklogItem>;
  /** what each item was added with, which a reopen goes back to (a start overwrote the branch and the repo) */
  added: Map<string, { branch: string | null; repo: string | null }>;
  /** when each item was last reopened, put on hold and set aside, which `parked_at` reads */
  marks: Map<string, BacklogMarks>;
  order: string[];
}

/** One event applied to the card it names (`item`, undefined for an id no add made yet); each op takes the events that apply to its card and ignores the rest. */
interface BacklogStep<Op extends BacklogEvent['op'] = BacklogEvent['op']> {
  fold: BacklogFold;
  event: Extract<BacklogEvent, { op: Op }>;
  item: BacklogItem | undefined;
  when: string;
  who: string;
}

const notDropped = (item: BacklogItem | undefined): item is BacklogItem =>
  !!item && item.state !== 'dropped';

/** A card whose work has not landed and is not dropped: an open or started one. */
const notLanded = (item: BacklogItem | undefined): item is BacklogItem =>
  notDropped(item) && !item.landed_at;

function foldAdd({ fold, event, item, when, who }: BacklogStep<'add'>): void {
  if (item) {
    return;
  }
  const id = event.id;
  fold.order.push(id);
  fold.added.set(id, { branch: event.branch || null, repo: event.repo || null });
  fold.items.set(id, {
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
    hold: false,
    critic_skipped: false,
    someday: false,
  });
}

function foldStart({ event, item, when, who }: BacklogStep<'start'>): void {
  // (a start that landed after a drop, from a writer that read before it, doesn't bring the item back)
  if (!notDropped(item)) {
    return;
  }
  // a start on a card already started and not landed is the same work on another branch (`backlog branch`): who started
  // it and when stand, as the board's elapsed time reads them
  const sameWork = item.state === 'started' && !item.landed_at && !!item.started_at;
  item.state = 'started';
  item.branch = event.branch;
  item.repo = event.repo || item.repo;
  if (!sameWork) {
    item.started_at = when;
    item.started_by = who;
  }
  // a new start is new work: an earlier landing no longer speaks for it
  item.landed_at = null;
  item.landed_sha = null;
  item.someday = false;
}

function foldDone({ event, item, when }: BacklogStep<'done'>): void {
  // (an open item an agent works on is started by what the board finds, so it can land with no `start`)
  if (!item || (item.state !== 'started' && item.state !== 'open')) {
    return;
  }
  // landing is once: a later `done` can only move the time earlier (an earlier `merged_at`), and fills a sha only when none
  const landedAt = event.merged_at || when;
  if (!item.landed_at || Date.parse(landedAt) < Date.parse(item.landed_at)) {
    item.landed_at = landedAt;
  }
  item.landed_sha = item.landed_sha || event.sha || null;
  item.someday = false;
}

function foldLink({ event, item }: BacklogStep<'link'>): void {
  if (!notLanded(item)) {
    return;
  }
  // a fact learned about the work: only the fields the event carries are set, nothing else about the card moves
  item.repo = event.repo || item.repo;
  item.branch = event.branch || item.branch;
  item.worktree = event.worktree || item.worktree;
  item.pr = event.pr || item.pr;
  item.story = event.story || item.story;
  item.session = event.session || item.session;
  item.source = event.source ?? item.source;
}

/** An old row (nothing writes one now): its checkout is the card's until a `link` says another, and it ends someday. */
function foldClaim({ event, item }: BacklogStep<'claim'>): void {
  if (!notDropped(item)) {
    return;
  }
  item.worktree ??= event.worktree || null;
  item.someday = false;
}

function foldHold({ fold, event, item, when }: BacklogStep<'hold'>): void {
  if (notDropped(item)) {
    item.hold = event.on !== false;
    fold.marks.set(item.id, {
      ...fold.marks.get(item.id),
      hold: item.hold ? when : undefined,
    });
  }
}

function foldSkipCritic({ event, item }: BacklogStep<'skip_critic'>): void {
  if (notDropped(item)) {
    item.critic_skipped = event.on !== false;
  }
}

function foldSomeday({ fold, event, item, when }: BacklogStep<'someday'>): void {
  if (item && item.state === 'open' && !item.landed_at) {
    item.someday = event.on !== false;
    fold.marks.set(item.id, {
      ...fold.marks.get(item.id),
      someday: item.someday ? when : undefined,
    });
  }
}

function foldDrop({ item, when }: BacklogStep<'drop'>): void {
  if (item) {
    item.state = 'dropped';
    item.dropped_at = when;
    item.someday = false;
  }
}

function foldReopen({ fold, item, when }: BacklogStep<'reopen'>): void {
  if (!item || item.state !== 'dropped') {
    return;
  }
  // back to an open item: the work it was started on no longer speaks for it, and it keeps its place in the order
  item.state = 'open';
  item.dropped_at = null;
  fold.marks.set(item.id, {
    ...fold.marks.get(item.id),
    reopened: when,
    hold: undefined,
    someday: undefined,
  });
  item.started_at = null;
  item.started_by = null;
  item.landed_at = null;
  item.landed_sha = null;
  item.branch = fold.added.get(item.id)?.branch ?? null;
  item.repo = fold.added.get(item.id)?.repo ?? null;
  item.hold = false;
  item.critic_skipped = false;
  item.someday = false;
}

function foldEdit({ fold, event, item }: BacklogStep<'edit'>): void {
  if (!notLanded(item)) {
    return;
  }
  // only the fields the event carries change (a note or repo of '' clears it); a title is never blanked.
  // A started card takes the story only: its title, note and repo stay what its work began with
  if (item.state === 'open') {
    editOpen(fold, event, item);
  }
  if (typeof event.story === 'string') {
    item.story = event.story || null;
  }
}

/** The title, note and repo an edit sets on an open card. */
function editOpen(
  fold: BacklogFold,
  event: Extract<BacklogEvent, { op: 'edit' }>,
  item: BacklogItem,
): void {
  if (event.title) {
    item.title = event.title;
  }
  if (typeof event.note === 'string') {
    item.note = event.note || null;
  }
  if (typeof event.repo === 'string') {
    item.repo = event.repo || null;
    // a reopen goes back to the repo the item has now, not the one it was added with
    fold.added.set(item.id, { branch: fold.added.get(item.id)?.branch ?? null, repo: item.repo });
  }
}

/** Where a moved card goes in the order (the card is already out of it): an edge, or before another card. */
function placeFor(order: string[], event: Extract<BacklogEvent, { op: 'move' }>): number {
  if (!event.edge) {
    return order.indexOf(event.before as string);
  }
  return event.edge === 'top' ? 0 : order.length;
}

function foldMove({ fold, event, item }: BacklogStep<'move'>): void {
  if (!item) {
    return;
  }
  const { order } = fold;
  // a target that is gone or unknown leaves the item where it was
  const target = event.before ? order.indexOf(event.before) : -1;
  if (event.edge || (target >= 0 && event.before !== item.id)) {
    order.splice(order.indexOf(item.id), 1);
    order.splice(placeFor(order, event), 0, item.id);
  }
}

/** How each op changes its card. */
const BACKLOG_STEPS: { [Op in BacklogEvent['op']]?: (step: BacklogStep<Op>) => void } = {
  add: foldAdd,
  start: foldStart,
  done: foldDone,
  link: foldLink,
  claim: foldClaim,
  hold: foldHold,
  skip_critic: foldSkipCritic,
  someday: foldSomeday,
  drop: foldDrop,
  reopen: foldReopen,
  edit: foldEdit,
  move: foldMove,
};

/** A mark counts while it stands: a start ends someday, and hold or someday off end theirs. */
function parkedAt(item: BacklogItem, mark: BacklogMarks): string | null {
  const times = [
    mark.reopened,
    item.hold ? mark.hold : undefined,
    item.someday ? mark.someday : undefined,
  ]
    .filter((time): time is string => !!time)
    .sort();
  return times.length ? times[times.length - 1] : null;
}

/** The items the events fold to, by id, oldest first. */
export function foldBacklogEvents(events: BacklogEvent[]): BacklogItem[] {
  const fold: BacklogFold = { items: new Map(), added: new Map(), marks: new Map(), order: [] };
  for (const event of events) {
    const step = BACKLOG_STEPS[event.op] as ((step: BacklogStep) => void) | undefined;
    step?.({
      fold,
      event,
      item: fold.items.get(event.id),
      when: event.at ?? '',
      who: event.by ?? 'cli',
    });
  }
  for (const [id, mark] of fold.marks) {
    const item = fold.items.get(id) as BacklogItem;
    item.parked_at = parkedAt(item, mark);
  }
  return fold.order.map((id) => fold.items.get(id) as BacklogItem);
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

/** What an edit changes: only the fields that differ from the card now, checked. */
function editChanges(item: BacklogItem, input: EditInput): Record<string, string> {
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
  return changes;
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
    const given = {
      repo,
      branch,
      worktree: facts.worktree,
      pr: facts.pr,
      story: facts.story,
      session: facts.session,
    };
    // only what is given and differs from what the card has
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(given).filter(
        ([key, value]) => value && value !== item[key as keyof typeof given],
      ),
    );
    if (input.source === 'backlog' && !isListed(item)) {
      changes.source = 'backlog';
    }
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
   * dropped card, and for one whose run is open (the card's runs say it is worked): `agents` is the registry's.
   */
  someday(
    id: string,
    aside: boolean,
    who?: string | null,
    agents: LedgerAgent[] = [],
  ): BacklogItem {
    const item = this.find(id);
    if (aside && (item.state !== 'open' || item.landed_at)) {
      throw new Error(
        `${id} is ${item.landed_at ? 'done' : item.state}, only an open card can be someday`,
      );
    }
    // a finished run's card is free; dispatch registers its run in the same call, so a card just handed out has one
    const run = workAgent(item, agents);
    if (aside && run && OPEN.includes(run.state)) {
      throw new Error(`${id} is worked by ${run.name}: it can be someday once that run is over`);
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
    const changes = editChanges(item, input);
    if (Object.keys(changes).length) {
      this.append({ op: 'edit', id, ...changes, by: clean(who, 'the name', BY_MAX) || 'cli' });
    }
    return this.find(id);
  }

  /** Records that a started item's work landed (deploy-local.sh, or the board seeing its PR merge), with the sha it landed as when known. */
  done(id: string, input: DoneInput = {}): BacklogItem {
    const item = this.find(id);
    if (item.state === 'dropped') {
      throw new Error(`${id} is dropped, only a started or open item can be done`);
    }
    // when GitHub merged it: a time that does not parse, or is in the future (a clock skew), is dropped, not an error
    const mergedMs = Date.parse(input.mergedAt ?? '');
    const mergedAt =
      Number.isFinite(mergedMs) && mergedMs <= Date.now() ? new Date(mergedMs).toISOString() : null;
    this.append({
      op: 'done',
      id,
      sha: optional(input.sha, 'the sha', SHA_RE),
      ...(mergedAt ? { merged_at: mergedAt } : {}),
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
          worktree: item.worktree,
          agentMade: item.source === 'agent',
        }
      : null;
  };

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

/** Where a backlog item sits on the board: its column, since when, and what the runs said of it. */
interface Placement {
  column: BoardCard['column'];
  since: string | null;
  tried: boolean;
  outside: CardPhase['outside'];
}

/** The place a card's runs put it (cardPhase): Working while the author runs, Agent checks at a plan stop, Waiting at a question, then by what it produced. */
function placeByPhase(item: BacklogItem, placed: CardPhase): Placement {
  let since: string | null = item.started_at ?? item.added_at ?? null;
  if (placed.column === 'backlog') {
    since = item.added_at || null;
  } else if (placed.when !== null) {
    since = new Date(placed.when).toISOString();
  }
  return { column: placed.column, since, tried: placed.tried, outside: placed.outside };
}

/** The place the runs give an item; null when the runs leave it out of the board. */
function placeByRuns(
  item: BacklogItem,
  link: BoardStartedLinks | undefined,
  phases: Map<string, CardPhase | null>,
): Placement | null {
  if (phases.has(item.id) && !(item.state === 'started' && (link?.merged || item.landed_at))) {
    const placed = phases.get(item.id);
    return placed ? placeByPhase(item, placed) : null;
  }
  return { column: 'backlog', since: item.added_at || null, tried: false, outside: undefined };
}

/** The place of a started item: Done (for DONE_HOURS) once its work landed or merged, else the place its runs gave it; null when it is gone. */
function placeStarted(
  item: BacklogItem,
  link: BoardStartedLinks | undefined,
  place: Placement,
  nowMs: number,
): Placement | null {
  const landed = endedColumn(
    link,
    Date.parse(item.started_at ?? ''),
    Date.parse(item.landed_at ?? ''),
  );
  if (!landed) {
    return place;
  }
  // landed or merged: Done for DONE_HOURS from then, as far as is known
  if (nowMs - landed.when > DONE_HOURS * 3600 * 1000) {
    return null;
  }
  return {
    ...place,
    column: landed.column,
    tried: false,
    since: new Date(landed.when).toISOString(),
  };
}

/** The board card of a shown backlog item. */
function backlogCardOf(
  item: BacklogItem,
  facts: {
    original: BacklogItem;
    derived: boolean;
    link: BoardStartedLinks | undefined;
    views: BoardAgent[];
  },
  place: Placement,
  phases: Map<string, CardPhase | null>,
): BoardCard {
  const { original, derived, link, views } = facts;
  const { column, since, tried, outside } = place;
  return {
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
    agents: column === 'backlog' && (item.state !== 'started' || phases.has(item.id)) ? [] : views,
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
              links: link ?? null,
            }
          : null,
      ...(item.someday && item.state === 'open' && column === 'backlog'
        ? { someday: true as const }
        : {}),
      start_line: startLine(item),
      // an open item whose run is in the registry: what is working it, or who tried it
      agent: original.state === 'open' && !derived && link?.agent ? { links: link, tried } : null,
    },
  };
}

/** Whether a started item with a branch rode on the work or session card for that branch (its runs' views go there). */
function mergedIntoWorkCard(item: BacklogItem, cards: BoardCard[], views: BoardAgent[]): boolean {
  const work = item.state === 'started' && item.branch ? cardOnBranch(item, cards) : undefined;
  if (work) {
    mergeIntoWork(work, item, views);
  }
  return !!work;
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
 * this one, in `agents` (`views`, by item id).
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
    const itemViews = views.get(item.id) ?? [];
    if (mergedIntoWorkCard(item, cards, itemViews)) {
      continue;
    }
    const byRuns = placeByRuns(item, link, phases);
    const place =
      byRuns && item.state === 'started' ? placeStarted(item, link, byRuns, nowMs) : byRuns;
    if (place) {
      shown.push(backlogCardOf(item, { original, derived, link, views: itemViews }, place, phases));
    }
  }
  return shown;
}
