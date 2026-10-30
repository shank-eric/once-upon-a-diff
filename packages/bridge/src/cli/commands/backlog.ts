/*
 * The backlog from the terminal: `once-upon backlog add|list|show|start|drop`. It reads and writes the backlog file
 * (services/backlog/backlog.ts) in-process, so nothing goes over HTTP; the board shows the items as its Backlog column.
 */
import { formatTime } from '../../services/config/settings.ts';
import { repoOfCheckout, currentBranch, sameRepo } from '../../services/config/repos.ts';

import { BacklogStore } from '../../services/backlog/backlog.ts';
import { DEFAULT_BRANCHES } from '../../services/review/story-lists.ts';
import { out } from '../output.ts';
import type { BacklogItem } from '../../services/backlog/backlog.ts';
import type { Config } from '../../services/config/settings.ts';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME] [--by NAME]\n' +
  '       once-upon backlog list [--all] [--json]\n' +
  '       once-upon backlog show ID\n' +
  '       once-upon backlog start ID [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog move ID --before ID | --top | --bottom\n' +
  '       once-upon backlog done ID [--sha SHA] [--by NAME]\n' +
  '       once-upon backlog done --branch NAME [--sha SHA] [--by NAME]\n' +
  '       once-upon backlog drop ID';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function describe(item: BacklogItem, home: string): string {
  const where = [item.repo, item.branch].filter(Boolean).join(' ');
  return [
    item.id,
    item.landed_at ? 'done' : item.state,
    where || '-',
    item.title,
    formatTime(item.added_at, home),
  ].join('\t');
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
    return out(`${started.id} started on ${started.branch}: ${started.title}`);
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
    // by id, or every started item on a branch of a repo (what deploy-local.sh knows: --repo, else this checkout's);
    // none on the branch is not an error
    const branch = text(opts.branch);
    const repo = text(opts.repo) ?? repoOfCheckout(process.cwd());
    if (!words[0] && !branch) {
      throw new Error('mark an item done by ID, or by --branch NAME');
    }
    const targets = words[0]
      ? [found()]
      : store
          .items()
          .filter(
            (one) =>
              one.state === 'started' &&
              one.branch === branch &&
              sameRepo(one.repo, repo) &&
              !one.landed_at,
          );
    for (const item of targets) {
      const landed = store.done(item.id, { sha: text(opts.sha), by: who });
      out(
        `${landed.id} done${landed.landed_sha ? ` at ${landed.landed_sha}` : ''}: ${landed.title}`,
      );
    }
    return;
  }
  if (verb === 'drop') {
    const item = found();
    store.drop(item.id, who);
    return out(`${item.id} dropped: ${item.title}`);
  }
  throw new Error(USAGE);
}

export const backlogCommands: Command[] = [
  {
    name: 'backlog',
    usage: [
      '  once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME]  keep something for later: a card in the board\'s Backlog column',
      '  once-upon backlog list [--all] [--json] | show ID | drop ID                     the items in board order (open ones, or all), one item, or drop one',
      '  once-upon backlog done ID | --branch NAME [--sha SHA]                           the work landed (a local deploy): the card goes to Done for a day',
      '  once-upon backlog move ID --before ID | --top | --bottom                        reorder: new items go to the bottom',
      "  once-upon backlog start ID [--branch NAME]                                       work began: the card moves onto that branch's work card",
    ],
    run: backlog,
  },
];
