/*
 * The backlog from the terminal: `once-upon backlog add|list|show|edit|start|claim|done|land|hold|drop|reopen`. It reads and writes the backlog file
 * (services/backlog/backlog.ts) in-process, so nothing goes over HTTP; the board shows the items as its Backlog column.
 */
import { formatTime } from '../../services/config/settings.ts';
import { repoOfCheckout, currentBranch } from '../../services/config/repos.ts';

import { BacklogStore, claimHint } from '../../services/backlog/backlog.ts';
import { landItems, recordedTips, runningAgents } from '../../services/backlog/landing.ts';
import { AgentRegistry } from '../../services/ledger/registry.ts';
import { DEFAULT_BRANCHES } from '../../services/review/story-lists.ts';
import { out } from '../output.ts';
import type { BacklogItem } from '../../services/backlog/backlog.ts';
import type { Config } from '../../services/config/settings.ts';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME] [--by NAME]\n' +
  '       once-upon backlog list [--all] [--json]\n' +
  '       once-upon backlog show ID\n' +
  '       once-upon backlog edit ID [--title TEXT] [--note TEXT] [--repo owner/name]\n' +
  '       once-upon backlog start ID [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog claim ID --agent NAME [--sid SID8] [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog move ID --before ID | --top | --bottom\n' +
  '       once-upon backlog done ID [--sha SHA] [--by NAME]\n' +
  '       once-upon backlog land [PICKED_SHA...] --from REF --to REF [--by NAME] [--dry-run]\n' +
  '       once-upon backlog hold ID [--off]\n' +
  '       once-upon backlog drop ID\n' +
  '       once-upon backlog reopen ID';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** done, else the state (marked when a deploy leaves the card to be closed by hand) */
const stateOf = (item: BacklogItem): string => {
  if (item.landed_at) {
    return 'done';
  }
  return item.hold ? `${item.state} (by hand)` : item.state;
};

function describe(item: BacklogItem, home: string): string {
  const where = [item.repo, item.branch].filter(Boolean).join(' ');
  return [item.id, stateOf(item), where || '-', item.title, formatTime(item.added_at, home)].join(
    '\t',
  );
}

function backlog(home: string, cfg: Config, opts: CliOpts) {
  const [verb, ...words] = opts._ || [];
  const store = new BacklogStore(home);
  const who = text(opts.by);
  const found = () => {
    const item = store.items().find((one) => one.id === words[0]);
    if (!item) {
      throw new Error(`no backlog item ${words[0] || ''}`.trim());
    }
    return item;
  };
  if (verb === 'add') {
    const item = store.add({
      title: words.join(' '),
      note: text(opts.note),
      // the checkout the command runs in names the repo unless --repo says otherwise
      repo: text(opts.repo) ?? repoOfCheckout(process.cwd()),
      branch: text(opts.branch),
      by: who,
    });
    return out(`${item.id} added: ${item.title}`);
  }
  if (verb === 'list') {
    const items = store.items().filter((item) => opts.all || item.state === 'open');
    if (opts.json) {
      return out(JSON.stringify(items, null, 2));
    }
    // in the board's order, numbered
    return out(
      items.length
        ? items.map((item, index) => `${index + 1}\t${describe(item, home)}`).join('\n')
        : 'No backlog items.',
    );
  }
  if (verb === 'show') {
    return out(JSON.stringify(found(), null, 2));
  }
  if (verb === 'edit') {
    const item = found();
    // a flag left out stays; an empty --note or --repo clears it (a flag with no value reads as true, so it is not text)
    const changes = { title: text(opts.title), note: text(opts.note), repo: text(opts.repo) };
    if (changes.title === null && changes.note === null && changes.repo === null) {
      throw new Error('change something: --title, --note or --repo');
    }
    const edited = store.edit(
      item.id,
      {
        title: changes.title ?? undefined,
        note: changes.note ?? undefined,
        repo: changes.repo ?? undefined,
      },
      who,
    );
    return out(`${edited.id} edited: ${edited.title}`);
  }
  if (verb === 'start') {
    const item = found();
    // the branch the session is on, unless it is a default branch (then the work has no branch yet: say which)
    const current = currentBranch(process.cwd());
    const branch =
      text(opts.branch) ??
      item.branch ??
      (current && !DEFAULT_BRANCHES.has(current) ? current : null);
    if (!branch) {
      throw new Error('this checkout is not on a work branch: pass --branch NAME');
    }
    const started = store.start(item.id, {
      branch,
      repo: text(opts.repo) ?? item.repo ?? repoOfCheckout(process.cwd()),
      by: who,
    });
    return out(
      `${started.id} started on ${started.branch}: ${started.title}\n${claimHint(started.id)}`,
    );
  }
  if (verb === 'claim') {
    // the agent (named as the ledger names it) owns the card: the board links the two by this and nothing else. --branch
    // also starts the card on that branch, so it rides on the branch's work card
    const item = found();
    const agent = text(opts.agent);
    if (!agent) {
      throw new Error('whose card? pass --agent NAME, the name the agent has in the ledger');
    }
    const claimed = store.claim(item.id, { agent, sid: text(opts.sid), by: who ?? agent });
    const branch = text(opts.branch);
    if (branch) {
      store.start(item.id, {
        branch,
        repo: text(opts.repo) ?? claimed.repo ?? repoOfCheckout(process.cwd()),
        by: who ?? agent,
      });
    }
    return out(
      `${item.id} claimed by ${agent}${branch ? `, started on ${branch}` : ''}: ${item.title}`,
    );
  }
  if (verb === 'move') {
    const item = found();
    const before = text(opts.before);
    if (!before && !opts.top && !opts.bottom) {
      throw new Error('move it --before ID, --top or --bottom');
    }
    const edge = opts.top ? 'top' : 'bottom';
    store.move(item.id, before ? { before } : { edge }, who);
    return out(`${item.id} moved ${before ? `before ${before}` : `to the ${edge}`}: ${item.title}`);
  }
  if (verb === 'done') {
    // by id: the work landed. A deploy marks cards by the commit each recorded (`land`), never by a branch name
    if (!words[0] || opts.branch) {
      throw new Error('mark an item done by ID: once-upon backlog done ID [--sha SHA]');
    }
    const landed = store.done(found().id, { sha: text(opts.sha), by: who });
    return out(
      `${landed.id} done${landed.landed_sha ? ` at ${landed.landed_sha}` : ''}: ${landed.title}`,
    );
  }
  if (verb === 'land') {
    // what deploy-local.sh runs after a deploy: --from the live commit before it, --to the deployed tip, and a batch
    // deploy's picked shas as words. The checkout is the one the command runs in.
    const from = text(opts.from);
    const upto = text(opts.to);
    if (!from || !upto) {
      throw new Error('which deploy? pass --from REF --to REF (the range that went live)');
    }
    const repo = process.cwd();
    const registry = new AgentRegistry(home);
    const found = landItems(
      repo,
      repoOfCheckout(repo),
      store.items(),
      recordedTips(registry.events()),
      { from, to: upto, picked: words },
      runningAgents(registry.agents()),
    );
    for (const { item, sha } of found.landed) {
      if (opts['dry-run']) {
        out(`${item.id} would be done at ${sha}: ${item.title}`);
      } else {
        const landed = store.done(item.id, { sha, by: who ?? 'land' });
        out(`${landed.id} done at ${landed.landed_sha}: ${landed.title}`);
      }
    }
    for (const item of found.held) {
      out(
        `${item.id} held, not marked (close it with: once-upon backlog done ${item.id}): ${item.title}`,
      );
    }
    for (const { item, why } of found.open) {
      out(
        `${item.id} still open, ${why}. If it landed: once-upon backlog done ${item.id} --sha SHA: ${item.title}`,
      );
    }
    return;
  }
  if (verb === 'hold') {
    const item = found();
    const held = store.hold(item.id, !opts.off, who);
    return out(
      held.hold
        ? `${held.id} held: a deploy will not mark it done, only backlog done ${held.id} does`
        : `${held.id} released: a deploy can mark it done again`,
    );
  }
  if (verb === 'drop') {
    const item = found();
    store.drop(item.id, who);
    return out(`${item.id} dropped: ${item.title}`);
  }
  if (verb === 'reopen') {
    const item = found();
    store.reopen(item.id, who);
    return out(`${item.id} reopened: ${item.title}`);
  }
  throw new Error(USAGE);
}

export const backlogCommands: Command[] = [
  {
    name: 'backlog',
    usage: [
      '  once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME]  keep something for later: a card in the board\'s Backlog column',
      '  once-upon backlog edit ID [--title TEXT] [--note TEXT] [--repo owner/name]      change an open card in place (an empty --note or --repo clears it)',
      '  once-upon backlog list [--all] [--json] | show ID | drop ID | reopen ID         the items in board order (open ones, or all), one item, drop one, or bring a dropped one back',
      '  once-upon backlog done ID [--sha SHA]                                            the work landed: the card goes to Done for an hour',
      '  once-upon backlog land [PICKED_SHA...] --from REF --to REF [--dry-run]           a deploy: mark done the cards whose recorded commit (agent finish --commit) is in the range',
      '  once-upon backlog hold ID [--off]                                                the card lands by hand: a deploy never marks it done',
      '  once-upon backlog move ID --before ID | --top | --bottom                        reorder: new items go to the bottom',
      "  once-upon backlog start ID [--branch NAME]                                       work began: the card moves onto that branch's work card",
      '  once-upon backlog claim ID --agent NAME [--sid SID8] [--branch NAME]            an agent takes the card: the board links card and agent only by this (--branch also starts it)',
    ],
    run: backlog,
  },
];
