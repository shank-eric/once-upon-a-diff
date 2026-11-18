/*
 * `once-upon card link ID`: writes a fact onto a stored card (ADR-29): its PR (confirmed against GitHub's head branch), story, branch
 * or worktree. `once-upon card status ID`: where a card stands and the rule that put it there. It reads the files only (ADR-15: the CLI never
 * calls the bridge, and `board` is not its to import), so the rule it prints is the run-decided one, the row of the table
 * `cardPhase` reads (state/src/queues/backlog/phase.ts, ADR-25), with the card's own facts and its runs. The board's columns.ts
 * may move the card further by its PR, its story review and its sessions; the page has the final column.
 */
import { formatTime, readSettings, repoSettings } from '@once-upon-a-diff/foundation/settings';
import { prHeadBranch } from '@once-upon-a-diff/foundation/gh';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { implicitItems } from '@once-upon-a-diff/state/queues/backlog/implicit';
import { PHASE_ROWS, cardPhase, runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import {
  liveWrites,
  runRegistry,
  trustedLiveSids,
} from '@once-upon-a-diff/core/features/runs/service';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon card status ID [--json] | once-upon card link ID [--pr N] [--story ID] [--branch B] [--worktree PATH]';

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

/** `card link`: the facts typed are written onto the stored card, once. A PR is checked: GitHub's head branch for it must be the card's branch (or give the card one). */
async function link(home: string, id: string, opts: CliOpts) {
  const store = new BacklogStore(home);
  const item = store.items().find((one) => one.id === id);
  if (!item) {
    throw new Error(`no card ${id}`);
  }
  const typedPr = text(opts.pr);
  const pr = typedPr === null ? null : Number(typedPr);
  if (typedPr !== null && !(Number.isInteger(pr) && (pr as number) > 0)) {
    throw new Error('--pr must be a PR number');
  }
  let branch = text(opts.branch);
  // a card's branch moves with its runs: backlog branch does both, so link never rewrites one
  if (branch && item.branch && branch !== item.branch) {
    throw new Error(
      `${id} is on ${item.branch}: once-upon backlog branch ${id} ${branch} moves it, and its runs`,
    );
  }
  if (pr !== null) {
    if (!item.repo) {
      throw new Error(`${id} has no repo: once-upon backlog edit ${id} --repo owner/name first`);
    }
    const head = await prHeadBranch(item.repo, pr);
    if (!head) {
      throw new Error(`#${pr} in ${item.repo} has no head branch`);
    }
    if (branch && branch !== head) {
      throw new Error(`#${pr} is on ${head}, not ${branch}: --branch must be the PR's head branch`);
    }
    if (item.branch && item.branch !== head) {
      throw new Error(`#${pr} is on ${head}, not ${item.branch}: it is another card's PR`);
    }
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

async function card(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, id] = opts._ || [];
  if (verb === 'link' && id) {
    return link(home, id, opts);
  }
  if (verb !== 'status' || !id) {
    throw new Error(USAGE);
  }
  // a self run whose session is gone is closed first, so the column below is the stored one (the board shows the same)
  const registry = runRegistry(home);
  registry.sweep({
    liveSids: await trustedLiveSids(home),
    lastWrite: await liveWrites(home, registry.agents()),
  });
  const agents = registry.agents();
  const store = new BacklogStore(home);
  const items = store.listed();
  // what the stored record says (ADR-29): a card an agent made is stored under its id, hidden from the lists until adopted
  const stored = store.items().find((one) => one.id === id);
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
          source: stored?.source ?? null,
          worktree: stored?.worktree ?? null,
          pr: stored?.pr ?? null,
          story: stored?.story ?? null,
          session: stored?.session ?? null,
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
    ...(stored
      ? [
          `record: source ${stored.source}${[
            stored.worktree && `worktree ${stored.worktree}`,
            stored.pr && `pr #${stored.pr}`,
            stored.story && `story ${stored.story}`,
            stored.session && `session ${stored.session}`,
          ]
            .filter(Boolean)
            .map((fact) => `, ${fact}`)
            .join('')}`,
        ]
      : []),
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
    subs: ['status', 'link'],
    usage: [
      "  once-upon card link ID [--pr N] [--story ID] [--branch B] [--worktree PATH]       writes a fact learned about a stored card onto it (the PR is checked against GitHub's head branch)",
      '  once-upon card status ID [--json]                                                where a card stands and the rule that put it there (the run-decided row of ADR-25; the board page has the final column)',
    ],
    run: card,
  },
];
