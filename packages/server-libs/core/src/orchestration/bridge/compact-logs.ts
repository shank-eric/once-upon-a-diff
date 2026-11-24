/*
 * `once-upon compact` (and `doctor --fix`): the logs only grow, so this rewrites three of them smaller. Each is replaced through adapters'
 * `replaceLog` (under the file's lock, nothing appended meanwhile is lost; the latest old log is kept beside it as
 * `<file>.<yyyymmdd>.bak`), and what goes out of agents.jsonl and backlog.jsonl is first appended to `<home>/archive/<store>-YYYY-MM.jsonl`
 * (adapters/src/stores/fs/archive.ts), which the board never reads and `card status` does.
 *   agents.jsonl  runs that are over for good (ended more than `archiveDays` ago, on cards that are done or dropped by then, not failed or failed and
 *                 acked) go with their lines to the archive; every other run keeps its last beat, and a finished run that ended inside `keepDays`
 *                 keeps all its beats (state/src/records/agents/compact.ts)
 *   inbox.jsonl   the chapter reads, positions and build lines nothing writes any more go, whatever their age, and every consumer's cursor
 *                 moves with the file; the conversation stays (state/src/queues/requests/inbox-compact.ts)
 *   backlog.jsonl the stored cards of agents, sessions, PRs and stories that no run names and nobody can still be on (closed before the
 *                 cutoff, or an idle agent or session card with no PR and no story) go with their events to the archive, after agents.jsonl is
 *                 compacted so the runs it keeps are the ones that name a card; a card someone added stays whole
 *                 (state/src/queues/backlog/backlog-compact.ts).
 * Before a file is swapped the folds of the old and the new lines are compared for every run and card that stays; a difference leaves
 * the file alone and says so. Nothing else rewrites a log, and a plain `doctor` only says when one is big.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { liveRegistry } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { appendArchive, monthOf } from '@once-upon-a-diff/adapters/stores/fs/archive';
import { jsonLines, readLogText, replaceLog } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { BacklogStore, foldBacklogEvents } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { planBacklogLines } from '@once-upon-a-diff/state/queues/backlog/backlog-compact';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { compactInboxText } from '@once-upon-a-diff/state/queues/requests/inbox-compact';
import { agentsFile, readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { foldAgentEvents, parseAgentEvents } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { planAgentLines } from '@once-upon-a-diff/state/records/agents/compact';
import { readBacklogEvent } from '@once-upon-a-diff/contracts/files/schemas';

/** A finished run that ended inside this many days keeps all its beats: none by default, a beat before the last is no reader's (the fold keeps the last). */
export const DEFAULT_KEEP_DAYS = 0;
/** Runs and cards closed for longer than this go to the archive. */
export const DEFAULT_ARCHIVE_DAYS = 30;

/**
 * A log this big gets a WARN from a plain doctor, naming `once-upon compact`. The limits sit above what a compacted log of this
 * size of work comes to (agents about 3.1 MB, inbox about 0.45 MB, backlog about 0.65 MB with 900 cards), so the warning means
 * compacting has not run for a while.
 */
export const BIG_LOG_BYTES: Record<string, number> = {
  'agents.jsonl': 3_500_000,
  'inbox.jsonl': 700_000,
  'backlog.jsonl': 1_000_000,
};

/** The sessions still running, whose cards stay; null when the registry cannot be trusted (every session card stays). */
export async function liveSessionIds(home: string): Promise<string[] | null> {
  const scan = await liveRegistry(readSettings(home).board.sessionsDir);
  const trusted = scan.health.folder === 'ok' && !scan.unknown;
  return trusted ? scan.sessions.map((one) => one.session) : null;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;

/** The logs over their size, as `name size` text. */
export function bigLogs(home: string): string[] {
  return Object.entries(BIG_LOG_BYTES).flatMap(([name, limit]) => {
    const file = path.join(home, name);
    const size = existsSync(file) ? statSync(file).size : 0;
    return size > limit ? [`${name} ${megabytes(size)}`] : [];
  });
}

const DAY_MS = 24 * 3600 * 1000;

/** The whole lines of a log's text. */
const linesOf = (whole: string) => whole.split('\n').slice(0, -1);
const textOf = (lines: string[]) => lines.map((line) => line + '\n').join('');

/** The archive rows of the lines, by the month of each line's own time (a line with no readable time goes to the month of `fallback`). */
function archiveRows(lines: string[], fallback: Date): { month: string; line: string }[] {
  return lines.map((line) => {
    let time: string | undefined;
    try {
      time = (JSON.parse(line) as { at?: string }).at;
    } catch {
      time = undefined;
    }
    return { month: monthOf(time) ?? fallback.toISOString().slice(0, 7), line };
  });
}

/** What the fold tells of each run that stays, apart from the runs an id had before its latest (they may have gone to the archive). */
function agentsDiffer(before: string[], after: string[]): boolean {
  const same = (one: LedgerAgent) => JSON.stringify({ ...one, earlier: undefined });
  const old = new Map(
    foldAgentEvents(parseAgentEvents(before.join('\n'))).map(
      (one) => [agentKey(one), same(one)] as const,
    ),
  );
  return foldAgentEvents(parseAgentEvents(after.join('\n'))).some(
    (one) => old.get(agentKey(one)) !== same(one),
  );
}

/** Whether a card that stays folds differently once the lines have gone. */
function cardsDiffer(before: string[], after: string[]): boolean {
  const fold = (lines: string[]) =>
    foldBacklogEvents(
      jsonLines(lines.join('\n')).flatMap((value) => readBacklogEvent(value) ?? []),
    );
  const old = new Map(fold(before).map((one) => [one.id, JSON.stringify(one)] as const));
  return fold(after).some((one) => old.get(one.id) !== JSON.stringify(one));
}

/** One log's report line: its size change and where the old log is kept. */
function sizeLine(
  name: string,
  done: { before: number; after: number; kept?: string },
  archived: number,
): string {
  const archive = archived ? `, ${archived} lines archived` : '';
  const kept = done.kept ? `, the old log is kept at ${done.kept}` : '';
  return `${name} ${megabytes(done.before)} -> ${megabytes(done.after)}${archive}${kept}`;
}

/**
 * Compacts the logs; one line each for what changed (none when there was nothing to drop). With `dryRun` nothing is written and each
 * line says what would change.
 */
export function compactLogs(
  home: string,
  {
    keepDays = DEFAULT_KEEP_DAYS,
    archiveDays = DEFAULT_ARCHIVE_DAYS,
    now = new Date(),
    liveSessions,
    dryRun = false,
  }: {
    /** a finished run that ended inside this many days keeps all its beats */
    keepDays?: number;
    /** runs and cards closed for longer than this go to the archive */
    archiveDays?: number;
    now?: Date;
    /** the full ids of the sessions still running, whose cards stay; null when the registry could not be trusted (every session card stays) */
    liveSessions: string[] | null;
    dryRun?: boolean;
  },
): string[] {
  const foldCutoff = now.getTime() - keepDays * DAY_MS;
  const cutoff = now.getTime() - archiveDays * DAY_MS;
  const report: string[] = [];

  /** Runs one log through its plan: `plan` returns the new text and the lines for the archive, or null to leave the log alone. */
  const compactOne = (
    file: string,
    name: string,
    store: string | null,
    plan: (whole: string) => { text: string; archived: string[] } | string | null,
    swap: { beforeSwap?: () => void } = {},
  ) => {
    const decide = (whole: string) => {
      const made = plan(whole);
      return typeof made === 'string' || made === null ? { text: made, archived: [] } : made;
    };
    if (dryRun) {
      const whole = readLogText(file);
      const made = decide(whole);
      if (made.text !== null) {
        report.push(
          `${sizeLine(name, { before: Buffer.byteLength(whole), after: Buffer.byteLength(made.text) }, made.archived.length)} (dry run, nothing written)`,
        );
      }
      return;
    }
    let archived = 0;
    const done = replaceLog(
      file,
      (whole) => {
        const made = decide(whole);
        if (made.text !== null && store && made.archived.length) {
          // the archive first: a crash from here on duplicates rows and loses none
          archived = appendArchive(home, store, archiveRows(made.archived, now));
        }
        return made.text;
      },
      { now, keepBackups: 1, ...swap },
    );
    if (done) {
      report.push(sizeLine(name, done, archived));
    }
  };
  const refused = (name: string) =>
    report.push(`${name} left alone: its runs or cards would not read the same after compacting`);

  const cards = new Map(
    new BacklogStore(home).items().map((item) => {
      const closedAt = Date.parse(item.dropped_at ?? item.landed_at ?? '');
      const closed = item.state === 'dropped' || !!item.landed_at;
      // a card closed after the cutoff keeps its runs, as an open card does
      return [item.id, closed && closedAt <= cutoff ? 'closed' : 'open'] as const;
    }),
  );
  const dry: { agents: string[] | null } = { agents: null }; // what a dry run's agents.jsonl would be
  compactOne(agentsFile(home), 'agents.jsonl', 'agents', (whole) => {
    const lines = linesOf(whole);
    const plan = planAgentLines(lines, cutoff, (card) => cards.get(card), foldCutoff);
    if (plan.kept.length === lines.length) {
      return null;
    }
    if (agentsDiffer(lines, plan.kept)) {
      refused('agents.jsonl');
      return null;
    }
    dry.agents = plan.kept;
    return { text: textOf(plan.kept), archived: plan.archived };
  });

  // the cards the retained runs name (read after agents.jsonl was compacted): a card a run is on stays, whatever its age
  const { agents, editors } =
    dryRun && dry.agents
      ? { agents: foldAgentEvents(parseAgentEvents(dry.agents.join('\n'))), editors: [] }
      : readAgents(home);
  const named = new Set<string>();
  const nameCards = (run: LedgerAgent) => {
    for (const card of [run.card, run.result?.card]) {
      if (card) {
        named.add(card);
      }
    }
  };
  for (const run of [...agents, ...editors]) {
    nameCards(run);
    (run.earlier ?? []).forEach(nameCards);
  }
  const backlog = new BacklogStore(home);
  compactOne(backlog.file, 'backlog.jsonl', 'backlog', (whole) => {
    const lines = linesOf(whole);
    const plan = planBacklogLines(lines, {
      cutoffMs: cutoff,
      named: (id) => named.has(id),
      live: (session) => liveSessions === null || liveSessions.includes(session),
    });
    if (plan.kept.length === lines.length) {
      return null;
    }
    if (cardsDiffer(lines, plan.kept)) {
      refused('backlog.jsonl');
      return null;
    }
    return { text: textOf(plan.kept), archived: plan.archived };
  });

  const inbox = new Inbox(home);
  let move = (offset: number) => offset;
  compactOne(
    inbox.file,
    'inbox.jsonl',
    null,
    (whole) => {
      const plan = compactInboxText(whole);
      move = plan.remap;
      return plan.removed ? plan.text : null;
    },
    { beforeSwap: () => inbox.moveCursors((offset) => move(offset)) },
  );
  return report;
}
