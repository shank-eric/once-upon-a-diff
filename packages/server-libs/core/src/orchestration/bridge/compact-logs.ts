/*
 * `once-upon doctor --fix`: the logs only grow, so this rewrites two of them smaller and keeps the old files beside them
 * (`<file>.<yyyymmdd>.bak`, adapters' `replaceLog`).
 *   agents.jsonl  runs that are over for good (older than the cutoff, on a card that is done, dropped or unknown, not failed or failed and acked) go
 *                 with their lines; a run that stays keeps its last beat (state/src/records/agents/compact.ts)
 *   inbox.jsonl   the chapter reads and positions older versions logged, older than the cutoff go, and every consumer's cursor
 *                 moves with the file (state/src/queues/requests/inbox-compact.ts)
 * backlog.jsonl is left alone: a card's events are what later moves and "already a card" refer to. The file is never rewritten
 * by anything else, and a plain `doctor` only says when a log is big.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { replaceLog } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { compactInboxText } from '@once-upon-a-diff/state/queues/requests/inbox-compact';
import { agentsFile } from '@once-upon-a-diff/state/records/agents/read';
import { compactAgentLines } from '@once-upon-a-diff/state/records/agents/compact';

export const DEFAULT_KEEP_DAYS = 14;

/** A log this big gets a WARN from a plain doctor, naming the fix. */
export const BIG_LOG_BYTES: Record<string, number> = {
  'agents.jsonl': 1_000_000,
  'inbox.jsonl': 500_000,
  'backlog.jsonl': 500_000,
};

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;

/** The logs over their size, as `name size` text. */
export function bigLogs(home: string): string[] {
  return Object.entries(BIG_LOG_BYTES).flatMap(([name, limit]) => {
    const file = path.join(home, name);
    const size = existsSync(file) ? statSync(file).size : 0;
    return size > limit ? [`${name} ${megabytes(size)}`] : [];
  });
}

/** Compacts the logs; one line each for what changed (none when there was nothing to drop). */
export function compactLogs(
  home: string,
  { keepDays = DEFAULT_KEEP_DAYS, now = new Date() }: { keepDays?: number; now?: Date } = {},
): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 3600 * 1000;
  const report: string[] = [];
  const note = (name: string, done: { before: number; after: number; kept: string } | null) => {
    if (done) {
      report.push(
        `${name} ${megabytes(done.before)} -> ${megabytes(done.after)}, the old log is kept at ${done.kept}`,
      );
    }
  };

  const cards = new Map(
    new BacklogStore(home)
      .items()
      .map(
        (item) =>
          [item.id, item.state === 'dropped' || item.landed_at ? 'closed' : 'open'] as const,
      ),
  );
  note(
    'agents.jsonl',
    replaceLog(
      agentsFile(home),
      (whole) => {
        const lines = whole.split('\n').slice(0, -1);
        const kept = compactAgentLines(lines, cutoff, (card) => cards.get(card));
        return kept.length === lines.length ? null : kept.map((line) => line + '\n').join('');
      },
      { now },
    ),
  );

  const inbox = new Inbox(home);
  let move = (offset: number) => offset;
  note(
    'inbox.jsonl',
    replaceLog(
      inbox.file,
      (whole) => {
        const plan = compactInboxText(whole, cutoff);
        move = plan.remap;
        return plan.removed ? plan.text : null;
      },
      { now, beforeSwap: () => inbox.moveCursors((offset) => move(offset)) },
    ),
  );
  return report;
}
