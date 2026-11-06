/*
 * Editors from the terminal: `once-upon editor start --slots N` registers the session that runs a repo's build queue as an
 * editor (the board's strip above the columns), and `once-upon editor slots [--json]` says how many of its slots its authors
 * hold, with the function the board uses (state/src/queues/backlog/slots.ts). An editor's kind is `editor`, which
 * `agent start` no longer takes: it is not an agent and holds no card, so it has its own door and its slots are required.
 */
import path from 'node:path';
import { repoOfCheckout } from '@once-upon-a-diff/foundation/repos';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { slotsInUse } from '@once-upon-a-diff/state/queues/backlog/slots';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { out } from '../output.ts';
import { warnTypedRepo } from '../typed-repo.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon editor start [NAME] --slots N [--task TEXT|--task-file PATH] [--repo owner/name] [--cwd DIR] [--sid SID8] [--model M] [--effort E]\n' +
  '       once-upon editor slots [NAME] [--sid SID8] [--json]';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function editor(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, given] = opts._ || [];
  const board = readSettings(home).board;
  const registry = new AgentRegistry(home, {
    ledger: board.ledgerFile,
    progress: board.progressFile,
  });
  const session = ownSession();
  const sid = text(opts.sid) ?? session?.slice(0, 8) ?? '';
  if (verb === 'start') {
    if (!text(opts.slots)) {
      throw new Error('an editor needs --slots N (how many authors it runs at once, 1 to 99)');
    }
    if (!sid) {
      throw new Error('a session id is needed (--sid SID8, or run it from a Claude session)');
    }
    const slots = text(opts.slots) as string;
    const cwd = path.resolve(text(opts.cwd) ?? process.cwd());
    warnTypedRepo(home, text(opts.repo), cwd);
    const started = registry.start({
      name: given ?? `editor-${sid}`,
      sid,
      session,
      kind: 'editor',
      task: text(opts.task) ?? `once-upon-editor, ${slots} slots`,
      model: text(opts.model),
      effort: text(opts.effort),
      repo: text(opts.repo) ?? repoOfCheckout(cwd),
      cwd,
      slots,
    });
    return out(`${started.id} ${started.run}`);
  }
  if (verb === 'slots') {
    // the named editor, else the one this session registered (its open run, the newest)
    const found = registry
      .agents()
      .filter(
        (agent) =>
          agent.kind === 'editor' &&
          runIsOpen(agent) &&
          (given ? agent.name === given : true) &&
          (text(opts.sid) || !given ? agent.sid === sid : true),
      )
      .sort(
        (first, second) => (second.started?.getTime() ?? 0) - (first.started?.getTime() ?? 0),
      )[0];
    if (!found) {
      let who = '';
      if (given) {
        who = ` named ${given}`;
      } else if (sid) {
        who = ` for session ${sid}`;
      }
      throw new Error(`no editor registered${who}: once-upon editor start --slots N`);
    }
    const used = slotsInUse(found, registry.agents(), new BacklogStore(home).items(), Date.now());
    if (opts.json) {
      return out(
        JSON.stringify(
          {
            editor: found.name,
            sid: found.sid,
            session: found.session ?? null,
            slots: used.slots,
            in_use: used.in_use,
            free: used.free,
            authors: used.authors.map((agent) => ({
              key: agentKey(agent),
              name: agent.name,
              state: agent.state,
              card: agent.card ?? null,
            })),
          },
          null,
          2,
        ),
      );
    }
    return out(`${used.in_use} of ${used.slots} slots in use (${used.free} free): ${found.name}`);
  }
  throw new Error(USAGE);
}

export const editorCommands: Command[] = [
  {
    name: 'editor',
    subs: ['start', 'slots'],
    usage: [
      "  once-upon editor start [NAME] --slots N [--task TEXT]   register this session as an editor, the one that runs a repo's build queue (--slots is required; prints its id and run)",
      "  once-upon editor slots [NAME] [--json]                   how many of its slots its authors hold (running, plan check or fixing), the board's count",
    ],
    run: editor,
  },
];
