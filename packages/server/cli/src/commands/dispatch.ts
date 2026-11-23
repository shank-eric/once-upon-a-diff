/*
 * `once-upon dispatch CARD --role ...`: launches an agent for a card in one call (core's features/runs/dispatch.ts): it registers
 * the run, which is what takes the card, and prints the Agent call's arguments and the brief to use as its prompt.
 * `once-upon handback NAME` is the agent's way back.
 */
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { sweepStatusLines } from '@once-upon-a-diff/core/features/sessions/status-lines';
import { callLine, dispatchRun, handbackRun } from '@once-upon-a-diff/core/features/runs/service';
import { carryApproval } from '@once-upon-a-diff/core/features/review/carry-approval';
import { shortSha } from '@once-upon-a-diff/terms/text';
import { given } from '../options.ts';
import { out } from '../output.ts';
import type { DispatchRole } from '@once-upon-a-diff/core/features/runs/service';
import type { CliOpts, Command } from '../types.ts';

const DISPATCH_USAGE =
  'usage: once-upon dispatch CARD --role author|fixer|critic|storyteller|helper|writer|finisher [--check TEXT] [--task TEXT|--task-file PATH] [--name NAME] [--branch NAME]\n' +
  '                           [--plan | --from-notes PATH] [--base REF] [--findings-from PATH] [--out PATH] [--fan-out] [--general] [--key K --dir D --story ID --failed K1,K2] [--json]';

async function dispatch(home: string, _cfg: unknown, opts: CliOpts) {
  const [card] = opts._ || [];
  const role = given(opts.role);
  if (!card || !role) {
    throw new Error(DISPATCH_USAGE);
  }
  const session = ownSession();
  const done = await dispatchRun(
    home,
    {
      card,
      role: role as DispatchRole,
      cwd: process.cwd(),
      session,
      sid: given(opts.sid),
      name: given(opts.name),
      branch: given(opts.branch),
      task: given(opts.task),
      check: given(opts.check),
      plan: !!opts.plan,
      fromNotes: given(opts['from-notes']),
      base: given(opts.base),
      findingsFrom: given(opts['findings-from']),
      out: given(opts.out),
      fanOut: !!opts['fan-out'],
      general: !!opts.general,
      dir: given(opts.dir),
      key: given(opts.key),
      story: given(opts.story),
      failed: given(opts.failed),
    },
    { warn: (line) => process.stderr.write(line + '\n'), mirror: 'both' },
  );
  await sweepStatusLines(home);
  if (opts.json) {
    return out(
      JSON.stringify(
        {
          name: done.name,
          subagent_type: done.subagentType,
          model: done.model,
          effort: done.effort,
          description: done.description,
          run_in_background: true,
          prompt: done.prompt,
        },
        null,
        2,
      ),
    );
  }
  return out(`${callLine(done)}\n\n${done.prompt.trimEnd()}`);
}

const HANDBACK_USAGE =
  'usage: once-upon handback NAME [--state done|failed|stopped|waiting|plan|review] [--outcome TEXT|--outcome-file PATH] [--findings N] [--sid SID8] [--plan] [--no-commit]';

function handback(home: string, _cfg: unknown, opts: CliOpts) {
  const [name] = opts._ || [];
  if (!name) {
    throw new Error(HANDBACK_USAGE);
  }
  const done = handbackRun(
    home,
    name,
    {
      state: given(opts.state),
      outcome: given(opts.outcome),
      findings: given(opts.findings),
      sid: given(opts.sid),
      prefer: ownSession()?.slice(0, 8) ?? null,
      plan: !!opts.plan,
      noCommit: !!opts['no-commit'],
    },
    { warn: (line) => process.stderr.write(line + '\n'), mirror: 'both' },
  );
  if (!done.ended) {
    return out(`${name} ${done.run.state}`);
  }
  // a fixer's commit on an approved story's card keeps the approval, as `agent finish` does
  const carried = carryApproval(home, done.run);
  return out(
    `${name} finished` +
      (carried
        ? `, approval carried ${shortSha(carried.from)} -> ${shortSha(carried.to)}${carried.via ? ` (${carried.via})` : ''}`
        : ''),
  );
}

export const dispatchCommands: Command[] = [
  {
    name: 'dispatch',
    usage: [
      '  once-upon dispatch CARD --role author|fixer|critic|storyteller|helper|writer|finisher   start the agent’s run on the card and print the Agent call and its brief',
      '                                                                                   --check TEXT: the success check (an author and a fixer need one); --task TEXT|--task-file PATH: the goal and file:line pointers',
      '                                                                                   --plan: an author that stops at its plan; --from-notes PATH: the fresh build from a checked plan',
      '                                                                                   --name NAME (default by role), --branch NAME (a card with no branch), --base REF, --findings-from PATH (a fixer), --out PATH (a critic’s file)',
      '                                                                                   --fan-out (a storyteller of a story the user reviews); --key K --dir D (a chapter writer), --story ID --dir D [--failed K1,K2] (the finisher)',
      '                                                                                   --general: a general-purpose call (its lean type is not installed): the brief carries the type’s standing rules',
      '                                                                                   --json: the call as JSON. <home>/editor/brief-extra.md, when it exists, is appended to every brief',
    ],
    run: dispatch,
  },
  {
    name: 'handback',
    usage: [
      '  once-upon handback NAME [--state done|failed|stopped|waiting|plan|review] [--outcome TEXT]   the agent is done: records its branch tip, branch and card (nothing to type), or moves it (--plan: plan written)',
      '                                                                                   --findings N (a critic), --sid SID8 (the run’s session, which the brief names), --no-commit (a planner or capped author with no commit)',
    ],
    run: handback,
  },
];
