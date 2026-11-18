/*
 * `once-upon card status ID`: where a card stands and the rule that put it there. It reads the files only (ADR-15: the CLI never
 * calls the bridge, and `board` is not its to import), so the rule it prints is the run-decided one, the row of the table
 * `cardPhase` reads (state/src/queues/backlog/phase.ts, ADR-25), with the card's own facts and its runs. The board's columns.ts
 * may move the card further by its PR, its story review and its sessions; the page has the final column.
 */
import { formatTime, readSettings, repoSettings } from '@once-upon-a-diff/foundation/settings';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { implicitItems } from '@once-upon-a-diff/state/queues/backlog/implicit';
import { PHASE_ROWS, cardPhase, runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import { runRegistry, trustedLiveSids } from '@once-upon-a-diff/core/features/runs/service';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE = 'usage: once-upon card status ID [--json]';

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

async function card(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, id] = opts._ || [];
  if (verb !== 'status' || !id) {
    throw new Error(USAGE);
  }
  // a self run whose session is gone is closed first, so the column below is the stored one (the board shows the same)
  const registry = runRegistry(home);
  registry.sweep({ liveSids: await trustedLiveSids(home) });
  const agents = registry.agents();
  const items = new BacklogStore(home).items();
  const item = [...items, ...implicitItems(agents, items)].find((one) => one.id === id);
  if (!item) {
    throw new Error(`no card ${id}`);
  }
  const nowMs = Date.now();
  const runs = runsOf(item, agents);
  const phase = cardPhase(
    item,
    runs,
    nowMs,
    undefined,
    !!repoSettings(readSettings(home), item.repo).skips_review,
  );
  const column = phase ? (COLUMN_LABELS[phase.column] ?? phase.column) : null;
  if (opts.json) {
    return out(
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
          state: item.state,
          repo: item.repo,
          branch: item.branch,
          claim: item.claim,
          hold: item.hold,
          someday: item.someday,
          column: phase?.column ?? null,
          row: phase?.row ?? null,
          rule: phase ? PHASE_ROWS[phase.row] : null,
          tried: phase?.tried ?? false,
          runs: runs.map((run) => ({
            id: agentKey(run),
            run: run.run,
            kind: run.kind,
            state: run.state,
            started: run.started?.toISOString() ?? null,
            ended: run.ended?.toISOString() ?? null,
          })),
        },
        null,
        2,
      ),
    );
  }
  const where = [item.repo, item.branch].filter(Boolean).join(' ');
  const marks = [item.hold && 'hold', item.someday && 'someday'].filter(Boolean);
  const lines = [
    `${item.id}  ${item.title}`,
    `state: ${item.landed_at && item.state !== 'dropped' ? 'done' : item.state}${marks.length ? ` (${marks.join(', ')})` : ''}${where ? `  ${where}` : ''}`,
    item.claim
      ? `claim: ${item.claim.agent}${item.claim.sid ? ` (session ${item.claim.sid})` : ''}, ${formatTime(item.claim.at, home)}`
      : 'claim: none',
    runs.length ? 'runs, oldest first:' : 'runs: none',
    ...runs.map(
      (run) =>
        `  ${agentKey(run)}\t${run.kind}\t${run.state}${run.ended ? `\tended ${formatTime(run.ended.toISOString(), home)}` : ''}`,
    ),
  ];
  if (phase === undefined) {
    lines.push('column: Backlog (no run decides it: the card keeps its own state)');
  } else if (phase === null) {
    lines.push('column: off the board (past its Done hour)');
  } else {
    lines.push(
      `column: ${column}${phase.tried ? ' (tried: sent back by a failed or stopped run)' : ''}`,
      `rule: ${phase.row} ${PHASE_ROWS[phase.row]} (state/src/queues/backlog/phase.ts, ADR-25)`,
    );
  }
  lines.push(TIME_NOTE);
  return out(lines.join('\n'));
}

export const cardCommands: Command[] = [
  {
    name: 'card',
    subs: ['status'],
    usage: [
      '  once-upon card status ID [--json]                                                where a card stands and the rule that put it there (the run-decided row of ADR-25; the board page has the final column)',
    ],
    run: card,
  },
];
