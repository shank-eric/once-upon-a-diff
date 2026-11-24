/*
 * `once-upon card backfill [--dry-run] [--days N] [--cardless]`: stores the cards the registry's runs made before ADR-29 (the `ic_` ids), and with
 * `--cardless` gives the recent runs that name no card one each (core/src/features/runs/backfill.ts).
 * `once-upon card link ID`: writes a fact onto a stored card (ADR-29): its PR (confirmed against GitHub's head branch), story, branch
 * or worktree. `once-upon card status ID`: where a card stands and the rule that put it there. It reads the files only (ADR-15: the CLI never
 * calls the bridge, and `board` is not its to import), so the rule it prints is the run-decided one, the row of the table
 * `cardPhase` reads (state/src/queues/backlog/phase.ts, ADR-25), with the card's own facts and its runs. The board's columns.ts
 * may move the card further by its PR, its story review and its sessions; the page has the final column.
 */
import { formatTime, readSettings, repoSettings } from '@once-upon-a-diff/foundation/settings';
import { prHeadBranch } from '@once-upon-a-diff/foundation/gh';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { archivedCards } from '@once-upon-a-diff/state/queues/backlog/archive';
import { archivedAgents } from '@once-upon-a-diff/state/records/agents/archive';
import { PHASE_ROWS, cardPhase, runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import {
  backfillCards,
  backfillLine,
  BACKFILL_DAYS,
  liveWrites,
  runRegistry,
  trustedLiveSids,
} from '@once-upon-a-diff/core/features/runs/service';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { stateWord } from '@once-upon-a-diff/state/records/agents/ledger';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { out } from '../output.ts';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon card status ID [--json] | once-upon card link ID [--pr N] [--story ID] [--branch B] [--worktree PATH] | once-upon card backfill [--dry-run] [--days N] [--cardless]';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The column names the board shows for the columns a run can decide. */
const COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  working: 'Working',
  checks: 'Agent checks',
  waiting: 'Waiting',
  ready: 'Ready for your review',
  ship: 'Ready to ship',
  done: 'Done',
};

const TIME_NOTE =
  'The board may move it further by its PR, its story review and its sessions (columns.ts): the page has the final column.';

/** `--pr N`: a PR number, or none. */
function typedPrNumber(opts: CliOpts): number | null {
  const typed = text(opts.pr);
  if (typed === null) {
    return null;
  }
  const pr = Number(typed);
  if (!(Number.isInteger(pr) && pr > 0)) {
    throw new Error('--pr must be a PR number');
  }
  return pr;
}

/** The PR's head branch, which must fit the card and any typed --branch: a PR is another card's when it is on a different branch. */
async function headOfPr(item: BacklogItem, pr: number, typedBranch: string | null) {
  if (!item.repo) {
    throw new Error(
      `${item.id} has no repo: once-upon backlog edit ${item.id} --repo owner/name first`,
    );
  }
  const head = await prHeadBranch(item.repo, pr);
  if (!head) {
    throw new Error(`#${pr} in ${item.repo} has no head branch`);
  }
  if (typedBranch && typedBranch !== head) {
    throw new Error(
      `#${pr} is on ${head}, not ${typedBranch}: --branch must be the PR's head branch`,
    );
  }
  if (item.branch && item.branch !== head) {
    throw new Error(`#${pr} is on ${head}, not ${item.branch}: it is another card's PR`);
  }
  return head;
}

/** `card link`: the facts typed are written onto the stored card, once. A PR is checked: GitHub's head branch for it must be the card's branch (or give the card one). */
async function link(home: string, id: string, opts: CliOpts) {
  const store = new BacklogStore(home);
  const item = store.items().find((one) => one.id === id);
  if (!item) {
    throw new Error(`no card ${id}`);
  }
  const pr = typedPrNumber(opts);
  const typedBranch = text(opts.branch);
  // a card's branch moves with its runs: backlog branch does both, so link never rewrites one
  if (typedBranch && item.branch && typedBranch !== item.branch) {
    throw new Error(
      `${id} is on ${item.branch}: once-upon backlog branch ${id} ${typedBranch} moves it, and its runs`,
    );
  }
  // a PR gives the card its head branch, unless the card has one already
  const head = pr === null ? null : await headOfPr(item, pr, typedBranch);
  let branch = typedBranch;
  if (pr !== null) {
    branch = item.branch ? null : head;
  }
  const linked = store.link(id, {
    pr,
    story: text(opts.story),
    branch,
    worktree: text(opts.worktree),
    by: text(opts.by),
  });
  const facts = [
    linked.pr && `pr #${linked.pr}`,
    linked.story && `story ${linked.story}`,
    linked.branch && `branch ${linked.branch}`,
    linked.worktree && `worktree ${linked.worktree}`,
  ].filter(Boolean);
  return out(`${id} linked: ${facts.join(', ') || 'nothing to link'}`);
}

/** `card backfill`: the counts of what was (or, with --dry-run, would be) written. */
function backfill(home: string, opts: CliOpts) {
  const days = opts.days === undefined ? BACKFILL_DAYS : Number(opts.days);
  if (!(days >= 0)) {
    throw new Error('--days takes a number of days, 0 or more');
  }
  const dryRun = opts['dry-run'] === true;
  const counts = backfillCards(home, { dryRun, cardless: opts.cardless === true, days });
  return out(backfillLine(counts, dryRun));
}

type Phase = ReturnType<typeof cardPhase>;

/** What `card status` reports on: the stored card, its runs and the run-decided phase. */
async function statusOf(home: string, id: string) {
  // a self run whose session is gone is closed first, so the column below is the stored one (the board shows the same)
  const registry = runRegistry(home);
  registry.sweep({
    liveSids: await trustedLiveSids(home),
    lastWrite: await liveWrites(home, registry.agents()),
  });
  const agents = registry.agents();
  const store = new BacklogStore(home);
  // the stored record (ADR-29): a card an agent made is stored under its id, hidden from the lists until adopted
  const stored = store.items().find((one) => one.id === id);
  // a card or runs that `once-upon compact` moved to the archive: the board never has them, status says so
  const archivedItem = stored ? undefined : archivedCards(home).find((one) => one.id === id);
  const item = stored ?? archivedItem;
  if (!item) {
    throw new Error(`no card ${id}`);
  }
  const runs = runsOf(item, agents);
  const archivedRuns = runsOf(item, archivedAgents(home));
  if (archivedItem) {
    return { item, stored, runs, archivedRuns, archivedCard: true, phase: undefined };
  }
  const skipsReview = !!repoSettings(readSettings(home), item.repo).skips_review;
  return {
    item,
    stored,
    runs,
    archivedRuns,
    archivedCard: false,
    phase: cardPhase(item, runs, Date.now(), undefined, skipsReview),
  };
}

type Status = Awaited<ReturnType<typeof statusOf>>;

function runJson(run: LedgerAgent) {
  return {
    id: agentKey(run),
    run: run.run,
    kind: run.kind,
    state: run.state,
    started: run.started?.toISOString() ?? null,
    ended: run.ended?.toISOString() ?? null,
  };
}

function statusJson({ item, stored, runs, archivedRuns, archivedCard, phase }: Status): string {
  return JSON.stringify(
    {
      id: item.id,
      title: item.title,
      state: item.state,
      repo: item.repo,
      branch: item.branch,
      hold: item.hold,
      someday: item.someday,
      source: stored?.source ?? null,
      worktree: stored?.worktree ?? null,
      pr: stored?.pr ?? null,
      story: stored?.story ?? null,
      session: stored?.session ?? null,
      column: phase?.column ?? null,
      row: phase?.row ?? null,
      rule: phase ? PHASE_ROWS[phase.row] : null,
      tried: phase?.tried ?? false,
      archivedCard,
      runs: runs.map(runJson),
      archivedRuns: archivedRuns.map(runJson),
    },
    null,
    2,
  );
}

function stateLine(item: BacklogItem): string {
  const where = [item.repo, item.branch].filter(Boolean).join(' ');
  const marks = [item.hold && 'hold', item.someday && 'someday'].filter(Boolean);
  const state = item.landed_at && item.state !== 'dropped' ? 'done' : item.state;
  return `state: ${state}${marks.length ? ` (${marks.join(', ')})` : ''}${where ? `  ${where}` : ''}`;
}

/** The stored record's own facts, none when the card is only its runs. */
function recordLines(stored: BacklogItem | undefined): string[] {
  if (!stored) {
    return [];
  }
  const facts = [
    stored.worktree && `worktree ${stored.worktree}`,
    stored.pr && `pr #${stored.pr}`,
    stored.story && `story ${stored.story}`,
    stored.session && `session ${stored.session}`,
  ]
    .filter(Boolean)
    .map((fact) => `, ${fact}`);
  return [`record: source ${stored.source}${facts.join('')}`];
}

/** The column the runs decide, and the rule row that decided it. */
function columnLines(phase: Phase): string[] {
  if (phase === undefined) {
    return ['column: Backlog (no run decides it: the card keeps its own state)'];
  }
  if (phase === null) {
    return ['column: off the board (past its Done hour)'];
  }
  const column = COLUMN_LABELS[phase.column] ?? phase.column;
  return [
    `column: ${column}${phase.tried ? ' (tried: sent back by a failed or stopped run)' : ''}`,
    `rule: ${phase.row} ${PHASE_ROWS[phase.row]} (state/src/queues/backlog/phase.ts, ADR-25)`,
  ];
}

function runLine(home: string, run: LedgerAgent): string {
  const ended = run.ended ? `\tended ${formatTime(run.ended.toISOString(), home)}` : '';
  return `  ${agentKey(run)}\t${run.kind}\t${stateWord(run)}${ended}`;
}

function statusText(
  home: string,
  { item, stored, runs, archivedRuns, archivedCard, phase }: Status,
): string {
  return [
    `${item.id}  ${item.title}`,
    stateLine(item),
    ...(archivedCard
      ? ['archived: the card left backlog.jsonl (once-upon compact); the board does not show it']
      : recordLines(stored)),
    runs.length ? 'runs, oldest first:' : 'runs: none',
    ...runs.map((run) => runLine(home, run)),
    ...(archivedRuns.length
      ? ['archived runs (once-upon compact moved them out of agents.jsonl):']
      : []),
    ...archivedRuns.map((run) => runLine(home, run)),
    ...(archivedCard ? [] : columnLines(phase)),
    TIME_NOTE,
  ].join('\n');
}

async function status(home: string, id: string, opts: CliOpts) {
  const found = await statusOf(home, id);
  return out(opts.json ? statusJson(found) : statusText(home, found));
}

/** `card VERB ID`: one function per verb. */
const VERBS: Record<string, (home: string, id: string, opts: CliOpts) => Promise<unknown>> = {
  link,
  status,
};

async function card(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, id] = opts._ || [];
  if (verb === 'backfill' && !id) {
    return backfill(home, opts);
  }
  if (!id || !Object.hasOwn(VERBS, verb ?? '')) {
    throw new Error(USAGE);
  }
  return VERBS[verb](home, id, opts);
}

export const cardCommands: Command[] = [
  {
    name: 'card',
    subs: ['status', 'link', 'backfill'],
    usage: [
      "  once-upon card link ID [--pr N] [--story ID] [--branch B] [--worktree PATH]       writes a fact learned about a stored card onto it (the PR is checked against GitHub's head branch)",
      '  once-upon card backfill [--dry-run] [--days N] [--cardless]                       stores the cards of the runs made before stored cards (`ic_` ids); --cardless also gives each recent cardless run (open, or ended in the last N days, 7) a card of its agent, which moves it on the board',
      '  once-upon card status ID [--json]                                                where a card stands and the rule that put it there (the run-decided row of ADR-25; the board page has the final column)',
    ],
    run: card,
  },
];
