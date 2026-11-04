/*
 * Agents from the terminal: `once-upon agent start|state|beat|finish|list`. The launching session (or the agent itself)
 * registers an agent and reports on it; each call is an event in <home>/agents.jsonl (services/ledger/events.ts), in-process,
 * and the board reads it from there. When the settings name a ledger or a progress file, each event also appends its
 * log line to it, so those files stay logs written by this command, for people and scripts (the board never reads them).
 * `--no-mirror` skips those lines, for a caller that writes the progress line itself (beat.sh), so one beat is one line. It goes after the words: a flag takes the next word.
 */
import path from 'node:path';
import { repoOfCheckout } from '../../services/config/repos.ts';
import { readSettings } from '../../services/config/settings.ts';
import { ownSession } from '../../services/listeners/binding.ts';
import type { AgentKind } from '../../services/ledger/agent-types.ts';
import { lastActivity } from '../../services/ledger/ledger.ts';
import { AgentRegistry } from '../../services/ledger/registry.ts';
import { out } from '../output.ts';
import type { Config } from '../../services/config/settings.ts';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon agent start NAME [--kind author|critic|helper|research|editor] [--standing] --task TEXT [--sid SID8] [--model M] [--effort E]\n' +
  '                             [--repo owner/name] [--branch NAME] [--pr N] [--cwd DIR] [--card ID] [--lane NAME] [--notes PATH] [--slots N]\n' +
  '       once-upon agent state NAME --state running|waiting|review|plan|fixing [--outcome TEXT] [--findings N] [--notes PATH] [--sid SID8] [--run ID]\n' +
  '       once-upon agent beat NAME N/M STEP [NOTE...] [--sid SID8] [--no-mirror]\n' +
  '       once-upon agent finish NAME [--state done|failed|stopped] [--outcome TEXT] [--commit SHA] [--pr N] [--branch NAME] [--card ID] [--findings N] [--notes PATH] [--sid SID8] [--run ID]\n' +
  '                              with none of --commit, --pr, --branch and --card, a registered branch that moved since the start is recorded as the result\n' +
  '       once-upon agent list [--all] [--json]';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function agent(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, name, ...words] = opts._ || [];
  const board = readSettings(home).board;
  // the caller already wrote the progress line (beat.sh echoes the progress line itself): the event is all this call adds
  const registry = new AgentRegistry(
    home,
    opts['no-mirror']
      ? { ledger: null, progress: null }
      : { ledger: board.ledgerFile, progress: board.progressFile },
  );
  const warn = (line: string) => process.stderr.write(line + '\n');
  const sid = text(opts.sid);
  const run = text(opts.run);
  // a subagent's own session breaks a tie between two sessions' open runs of one name (its sid is unknown to it otherwise)
  const prefer = ownSession()?.slice(0, 8) ?? null;
  const who = text(opts.by);
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
              return [`${one.sid}:${one.name}`, one.kind, one.state, beat, quiet, one.task].join(
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
    const session = ownSession();
    const cwd = path.resolve(text(opts.cwd) ?? process.cwd());
    const started = registry.start({
      name,
      sid: sid ?? session?.slice(0, 8) ?? '',
      session,
      kind: (text(opts.kind) ?? undefined) as AgentKind | undefined,
      // absent carries over from the earlier run; `--standing` or `--standing true` sets it, `--standing false` clears it
      standing: opts.standing === undefined ? undefined : opts.standing !== 'false',
      task: text(opts.task) ?? words.join(' '),
      model: text(opts.model),
      effort: text(opts.effort),
      // the checkout the agent works in names the repo unless --repo says otherwise
      repo: text(opts.repo) ?? repoOfCheckout(cwd),
      branch: text(opts.branch),
      pr: text(opts.pr),
      cwd,
      card: text(opts.card),
      lane: text(opts.lane),
      notes: text(opts.notes),
      slots: text(opts.slots),
      by: who,
    });
    return out(`${started.id} ${started.run}`);
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
    subs: ['start', 'state', 'beat', 'finish', 'list'],
    usage: [
      '  once-upon agent start NAME --kind author|critic|helper|research|editor --task TEXT   register an agent the board shows (its sid comes from the session; prints its id and run)',
      '                                                                                   --standing: a long-lived helper (the backlog clerk), in the Helpers row, never a card; put it before another flag. A restart of the same name may leave out --kind and --standing: they carry over (--standing false clears it)',
      '  once-upon agent state NAME --state running|waiting|review|plan|fixing            move it: a plan to check, a question, parked on a story review, fixing findings',
      '  once-upon agent beat NAME N/M STEP [NOTE...]                                     a progress beat, and a sign of life',
      '  once-upon agent finish NAME [--state done|failed|stopped] [--outcome TEXT]       it is over: --commit, --pr, --branch and --card say what it made',
      '  once-upon agent list [--all] [--json]                                            the registered agents (open ones, or all)',
    ],
    run: agent,
  },
];
