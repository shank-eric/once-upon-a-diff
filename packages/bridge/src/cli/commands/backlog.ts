/*
 * The backlog from the terminal: `once-upon backlog add|list|show|start|drop`. It reads and writes the backlog file
 * (board/backlog.ts) in-process, so nothing goes over HTTP; the board shows the items as its Backlog column.
 */
import { formatTime } from '../../config/settings.ts';
import { repoOfCheckout } from '../../config/repos.ts';
import { branchName } from '../../util/git.ts';
import { BacklogStore } from '../../board/backlog.ts';
import { DEFAULT_BRANCHES } from '../../board/board.ts';
import { out } from '../output.ts';
import type { BacklogItem } from '../../board/backlog.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

const USAGE =
  'usage: once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME] [--by NAME]\n' +
  '       once-upon backlog list [--all] [--json]\n' +
  '       once-upon backlog show ID\n' +
  '       once-upon backlog start ID [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog move ID --before ID | --top | --bottom\n' +
  '       once-upon backlog drop ID';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function describe(item: BacklogItem, home: string): string {
  const where = [item.repo, item.branch].filter(Boolean).join(' ');
  return [item.id, item.state, where || '-', item.title, formatTime(item.added_at, home)].join(
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
  if (verb === 'start') {
    const item = found();
    // the branch the session is on, unless it is a default branch (then the work has no branch yet: say which)
    const current = branchName(process.cwd());
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
      '  once-upon backlog move ID --before ID | --top | --bottom                        reorder: new items go to the bottom',
      "  once-upon backlog start ID [--branch NAME]                                       work began: the card moves onto that branch's work card",
    ],
    run: backlog,
  },
];
