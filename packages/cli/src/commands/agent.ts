/*
 * Agents from the terminal: `once-upon agent start|state|beat|finish|list`. The launching session (or the agent itself)
 * registers an agent and reports on it; each call is an event in <home>/agents.jsonl (state/src/records/agents/events.ts), in-process,
 * and the board reads it from there. When the settings name a ledger or a progress file, each event also appends its
 * log line to it, so those files stay logs written by this command, for people and scripts (the board never reads them).
 * `--no-mirror` skips those lines, for a caller that writes the progress line itself (beat.sh), so one beat is one line. It goes after the words: a flag takes the next word.
 */
import { agentId, isImplicitCard } from '@once-upon-a-diff/domain/ids';
import path from 'node:path';
import { repoOfCheckout } from '@once-upon-a-diff/foundation/repos';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { sweepStatusLines } from '@once-upon-a-diff/core/features/sessions/status-lines';
import type { AgentKind } from '@once-upon-a-diff/state/records/agents/agent-types';
import { canonicalKind } from '@once-upon-a-diff/state/records/agents/events';
import { lastActivity } from '@once-upon-a-diff/state/records/agents/ledger';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { out } from '../output.ts';
import { warnTypedRepo } from '../typed-repo.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon agent start NAME [--kind author|critic|helper|research | --role author|fixer|critic|storyteller|helper|research] [--standing] --task TEXT|--task-file PATH [--sid SID8] [--model M] [--effort E]\n' +
  '                             [--repo owner/name] [--branch NAME] [--pr N] [--cwd DIR] [--card ID | --new-card] [--lane NAME] [--notes PATH]\n' +
  '       once-upon agent state NAME --state running|waiting|review|plan|fixing [--outcome TEXT|--outcome-file PATH] [--findings N] [--notes PATH] [--sid SID8] [--run ID]\n' +
  '       once-upon agent beat NAME N/M STEP [NOTE...] [--sid SID8] [--no-mirror]\n' +
  '       once-upon agent finish NAME [--state done|failed|stopped] [--outcome TEXT|--outcome-file PATH] [--commit SHA] [--pr N] [--branch NAME] [--card ID] [--findings N] [--notes PATH] [--sid SID8] [--run ID]\n' +
  '                              with none of --commit, --pr, --branch and --card, a registered branch that moved since the start is recorded as the result\n' +
  '       once-upon agent sweep [--dry-run]\n' +
  '       once-upon agent list [--all] [--json]';

/** `--role` names what a run does on a card; the kind is what the board and the registry know it as. */
const ROLE_KIND: Record<string, string> = {
  author: 'author',
  fixer: 'author',
  critic: 'critic',
  storyteller: 'helper',
  helper: 'helper',
  research: 'research',
};
const NEEDS_CARD = ['critic', 'fixer', 'storyteller'];

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

async function agent(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, name, ...words] = opts._ || [];
  const board = readSettings(home).board;
  // the caller already wrote the progress line (beat.sh echoes the progress line itself): the event is all this call adds
  const registry = new AgentRegistry(
    home,
    opts['no-mirror']
      ? { ledger: null, progress: null }
      : { ledger: board.ledgerFile, progress: board.progressFile },
    // a run that names a card is checked against it (ADR-25)
    cardLookup(new BacklogStore(home)),
  );
  const warn = (line: string) => process.stderr.write(line + '\n');
  const sid = text(opts.sid);
  const run = text(opts.run);
  // a subagent's own session breaks a tie between two sessions' open runs of one name (its sid is unknown to it otherwise)
  const prefer = ownSession()?.slice(0, 8) ?? null;
  const who = text(opts.by);
  if (verb === 'sweep') {
    // runs silent for a day that owe beats are closed (registry.ts `sweep`); `agent start` does the same as it writes
    const swept = registry.sweep({ dryRun: !!opts['dry-run'] });
    // the day-old status line files of gone sessions go here too, not on the board's read
    const lines = opts['dry-run'] ? [] : await sweepStatusLines(home);
    const said = [
      ...swept.map(
        (one) =>
          `${agentKey(one)} ${opts['dry-run'] ? 'would be stopped' : 'stopped'}: silent since ${lastActivity(one)?.toISOString() ?? 'its start'}`,
      ),
      ...(lines.length ? [`${lines.length} status line file(s) of gone sessions removed`] : []),
    ];
    return out(said.length ? said.join('\n') : 'Nothing to sweep.');
  }
  if (verb === 'list') {
    const now = Date.now();
    const agents = registry
      .agents()
      .filter((one) => opts.all || ['running', 'waiting', 'plan', 'fixing'].includes(one.state));
    if (opts.json) {
      return out(JSON.stringify(agents, null, 2));
    }
    return out(
      agents.length
        ? agents
            .map((one) => {
              const beat = one.beat ? `${one.beat.n}/${one.beat.of} ${one.beat.step}` : '-';
              const last = lastActivity(one);
              const quiet = last ? `${Math.round((now - last.getTime()) / 60000)}m ago` : '-';
              return [agentId(one.sid, one.name), one.kind, one.state, beat, quiet, one.task].join(
                '\t',
              );
            })
            .join('\n')
        : 'No registered agents.',
    );
  }
  if (!name) {
    throw new Error(USAGE);
  }
  if (verb === 'start') {
    // an editor is not an agent: it registers through `editor start`, where its slots are required
    if (canonicalKind(text(opts.kind)) === 'editor' || opts.slots !== undefined) {
      throw new Error('register an editor with: once-upon editor start --slots N');
    }
    const session = ownSession();
    const cwd = path.resolve(text(opts.cwd) ?? process.cwd());
    const card = text(opts.card);
    // a role is a kind with a rule: a critic, a fixer and a storyteller work on a card, so they name it
    const role = text(opts.role);
    if (role && !Object.hasOwn(ROLE_KIND, role)) {
      throw new Error(`the role must be one of ${Object.keys(ROLE_KIND).join(', ')}`);
    }
    if (role && opts.kind && ROLE_KIND[role] !== canonicalKind(text(opts.kind))) {
      throw new Error('--role and --kind disagree: pass --role alone');
    }
    if (role && NEEDS_CARD.includes(role) && !card) {
      throw new Error(`a ${role} works on a card: pass --card ID`);
    }
    registry.sweep();
    await sweepStatusLines(home);
    // a repo typed on a run that has no card (or whose card has no repo yet, so the typed one is kept) is checked; a run on a card
    // that has a repo takes the card's, and the registry already says so
    const typedRepo = text(opts.repo);
    if (typedRepo && !(card && cardLookup(new BacklogStore(home))(card)?.repo)) {
      warnTypedRepo(home, typedRepo, cwd);
    }
    const started = registry.start(
      {
        name,
        sid: sid ?? session?.slice(0, 8) ?? '',
        session,
        kind: ((role ? ROLE_KIND[role] : text(opts.kind)) ?? undefined) as AgentKind | undefined,
        // absent carries over from the earlier run; `--standing` or `--standing true` sets it, `--standing false` clears it
        standing: opts.standing === undefined ? undefined : opts.standing !== 'false',
        task: text(opts.task) ?? words.join(' '),
        model: text(opts.model),
        effort: text(opts.effort),
        // the checkout the agent works in names the repo unless --repo says otherwise; a run on a card takes the card's
        repo: text(opts.repo) ?? (card ? null : repoOfCheckout(cwd)),
        branch: text(opts.branch),
        pr: text(opts.pr),
        cwd,
        card,
        newCard: !!opts['new-card'],
        role: role as NonNullable<Parameters<AgentRegistry['start']>[0]['role']> | null,
        lane: text(opts.lane),
        notes: text(opts.notes),
        by: who,
      },
      warn,
    );
    // an implicit card's id is printed beside the run's, so a later run on the same work (a critic of it) can pass --card
    return out(
      `${started.id} ${started.run}${isImplicitCard(started.card) ? ` ${started.card}` : ''}`,
    );
  }
  if (verb === 'state') {
    registry.state(
      name,
      {
        state: text(opts.state) as 'running',
        outcome: text(opts.outcome),
        findings: text(opts.findings),
        notes: text(opts.notes),
        sid,
        run,
        prefer,
        by: who,
      },
      warn,
    );
    return out(`${name} ${text(opts.state)}`);
  }
  if (verb === 'beat') {
    const [step, label, ...note] = words;
    const [done, total] = (step ?? '').split('/');
    registry.beat(
      name,
      { n: done, of: total, step: label, note: note.join(' '), sid, run, prefer, by: who },
      warn,
    );
    return out(`${name} ${step} ${label}`);
  }
  if (verb === 'finish') {
    registry.finish(
      name,
      {
        state: (text(opts.state) ?? undefined) as 'done' | undefined,
        outcome: text(opts.outcome),
        result: {
          commit: text(opts.commit),
          pr: text(opts.pr),
          branch: text(opts.branch),
          card: text(opts.card),
        },
        findings: text(opts.findings),
        notes: text(opts.notes),
        sid,
        run,
        prefer,
        by: who,
      },
      warn,
    );
    return out(`${name} finished`);
  }
  throw new Error(USAGE);
}

export const agentCommands: Command[] = [
  {
    name: 'agent',
    subs: ['start', 'state', 'beat', 'finish', 'sweep', 'list'],
    usage: [
      '  once-upon agent start NAME --kind author|critic|helper|research --task TEXT   register an agent the board shows (its sid comes from the session; prints its id and run)',
      '                                                                                   --card ID: the card it works on, whose repo and branch it takes (a critic, fixer or storyteller needs one; --role says which); --repo, --branch, --lane and --pr then say nothing the card does not',
      '                                                                                   no --card: the run is its own card (an implicit card, in the registry only: its id is printed after the run id, for a critic of the work to pass as --card); a restart of the same name stays on it, --new-card starts another',
      '                                                                                   --standing: a long-lived helper (the backlog clerk), in the Helpers row, never a card; put it before another flag. A restart of the same name may leave out --kind and --standing: they carry over (--standing false clears it)',
      '  once-upon agent state NAME --state running|waiting|review|plan|fixing            move it: a plan to check, a question, parked on a story review, fixing findings',
      '  once-upon agent beat NAME N/M STEP [NOTE...]                                     a progress beat, and a sign of life',
      '  once-upon agent finish NAME [--state done|failed|stopped] [--outcome TEXT]       it is over: --commit, --pr, --branch and --card say what it made',
      '  once-upon agent sweep [--dry-run]                                                stop runs silent for 24 hours that owe beats (running or fixing); agent start does it as it writes',
      '                                                                                   only authors and critics; never one parked on a question, plan or review, nor a helper of any kind or an editor',
      '  once-upon agent list [--all] [--json]                                            the registered agents (open ones, or all)',
    ],
    run: agent,
  },
];
