/*
 * The backlog from the terminal: `once-upon backlog add|list|show|edit|start|claim|done|land|hold|someday|drop|reopen`. It reads and writes the backlog file
 * (state/src/queues/backlog/backlog.ts) in-process, so nothing goes over HTTP; the board shows the items as its Backlog column.
 */
import path from 'node:path';
import { formatTime, DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import { repoOfCheckout, currentBranch, sameRepo } from '@once-upon-a-diff/foundation/repos';

import { BacklogStore, claimHint } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { claimWorktreeProblem } from '@once-upon-a-diff/state/queues/backlog/claim-worktree';
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { landItems, recordedTips } from '@once-upon-a-diff/state/queues/backlog/landing';
import { implicitCards } from '@once-upon-a-diff/state/records/agents/implicit';
import { implicitItems, liveImplicitIds } from '@once-upon-a-diff/state/queues/backlog/implicit';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { out } from '../output.ts';
import { warnTypedRepo } from '../typed-repo.ts';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon backlog add ("TITLE" | --title TEXT | --title-file PATH | --title -) [--note TEXT | --note-file PATH | --note -] [--repo owner/name] [--branch NAME] [--by NAME]\n' +
  '       once-upon backlog list [--all] [--json] [--someday] [--implicit]\n' +
  '       once-upon backlog adopt ID [--title TEXT] [--by NAME]\n' +
  '       once-upon backlog show ID\n' +
  '       once-upon backlog edit ID [--title TEXT] [--note TEXT | --note-file PATH | --note -] [--repo owner/name]\n' +
  '       once-upon backlog start ID [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog claim ID --agent NAME [--sid SID8] [--branch NAME] [--worktree PATH] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog branch ID NEW-BRANCH [--by NAME]\n' +
  '       once-upon backlog move ID --before ID | --top | --bottom\n' +
  '       once-upon backlog done ID [--sha SHA] [--by NAME]\n' +
  '       once-upon backlog land [PICKED_SHA...] --from REF --to REF [--by NAME] [--dry-run]\n' +
  '       once-upon backlog hold ID [--off]\n' +
  '       once-upon backlog someday ID [--off]\n' +
  '       once-upon backlog drop ID\n' +
  '       once-upon backlog reopen ID';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** the state the CLI reports: done once it landed (the store keeps started or open), unless it was dropped after */
const reported = (item: BacklogItem): string => {
  if (item.implicit) {
    return 'implicit';
  }
  return item.landed_at && item.state !== 'dropped' ? 'done' : item.state;
};

/** the reported state (marked when a deploy leaves the card to be closed by hand) */
const stateOf = (item: BacklogItem): string => {
  const state = reported(item);
  const marks = [item.hold && state !== 'done' && 'by hand', item.someday && 'someday'].filter(
    Boolean,
  );
  return marks.length ? `${state} (${marks.join(', ')})` : state;
};

/** an item as `show` and `list --json` print it, with its reported state */
const shown = (item: BacklogItem) => ({ ...item, state: reported(item) });

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
  // the implicit cards (ADR-27) are the registry's runs: they are in no backlog file until adopted
  const implicit = () => implicitItems(new AgentRegistry(home).agents(), store.items());
  const found = () => {
    const item = store.items().find((one) => one.id === words[0]);
    if (!item) {
      if (implicit().some((one) => one.id === words[0])) {
        throw new Error(
          `${words[0]} is an implicit card (a run that did not start in the backlog): once-upon backlog adopt ${words[0]} first`,
        );
      }
      throw new Error(`no backlog item ${words[0] || ''}`.trim());
    }
    return item;
  };
  if (verb === 'add') {
    // the title is the words after `add`, or --title / --title-file / --title - (not both)
    const flagged = text(opts.title);
    if (flagged !== null && words.length) {
      throw new Error('give the title as words or as --title, not both');
    }
    warnTypedRepo(home, text(opts.repo), process.cwd());
    const item = store.add({
      title: flagged ?? words.join(' '),
      note: text(opts.note),
      // the checkout the command runs in names the repo unless --repo says otherwise
      repo: text(opts.repo) ?? repoOfCheckout(process.cwd()),
      branch: text(opts.branch),
      by: who,
    });
    return out(`${item.id} added: ${item.title}`);
  }
  if (verb === 'adopt') {
    // an implicit card becomes a backlog card, with its own id: its runs already name it
    const [id] = words;
    if (store.items().some((one) => one.id === id)) {
      throw new Error(`${id} is already a card`);
    }
    const card = implicitCards(new AgentRegistry(home).agents()).find((one) => one.id === id);
    if (!card) {
      throw new Error(
        `no such card ${id ?? ''}: only an implicit card (ic_...) can be adopted`.trim(),
      );
    }
    const adopted = store.add({
      id: card.id,
      title: text(opts.title) ?? card.title,
      note: card.task && card.task !== card.title ? card.task : null,
      repo: card.repo,
      branch: card.branch,
      by: who ?? card.agent,
    });
    // a card with a branch is started on it, as `claim --branch` does, so it reads as work done or under way: no Assign while its
    // author runs, and a built card on a branch reaches Ready instead of leaving the board. Start needs a branch, so a card with
    // none stays open (its runs still decide its column)
    if (card.branch) {
      store.start(adopted.id, { branch: card.branch, repo: card.repo, by: who ?? card.agent });
    }
    return out(`${adopted.id} adopted: ${adopted.title}`);
  }
  if (verb === 'list') {
    if (opts.implicit) {
      // only the implicit cards: the live ones (a run open), or every one with --all
      const live = liveImplicitIds(new AgentRegistry(home).agents(), Date.now());
      const cards = implicit().filter((item) => opts.all || live.has(item.id));
      if (opts.json) {
        return out(JSON.stringify(cards, null, 2));
      }
      return out(
        cards.length
          ? cards.map((item, index) => `${index + 1}\t${describe(item, home)}`).join('\n')
          : 'No implicit cards.',
      );
    }
    const all = store.items().filter((item) => opts.all || reported(item) === 'open');
    // the Someday section is collapsed: out of the main list, and printed (expanded) only by --someday
    // (--all is everything, someday cards marked in place)
    const later = all.filter((item) => item.someday);
    let items = all.filter((item) => !item.someday);
    if (opts.someday) {
      items = later;
    } else if (opts.all) {
      items = all;
    }
    // --all is every card, the implicit ones too (marked)
    const withImplicit = opts.all && !opts.someday ? [...items, ...implicit()] : items;
    if (opts.json) {
      return out(JSON.stringify(withImplicit.map(shown), null, 2));
    }
    // in the board's order, numbered
    const lines = withImplicit.map((item, index) => `${index + 1}\t${describe(item, home)}`);
    if (opts.someday) {
      return out(
        later.length ? [`Someday (${later.length})`, ...lines].join('\n') : 'Nothing is someday.',
      );
    }
    if (later.length && !opts.all) {
      lines.push(`Someday (${later.length})`);
    }
    return out(items.length || later.length ? lines.join('\n') : 'No backlog items.');
  }
  if (verb === 'show') {
    const card = implicit().find((one) => one.id === words[0]);
    return out(JSON.stringify(shown(card ?? found()), null, 2));
  }
  if (verb === 'edit') {
    const item = found();
    // a flag left out stays; an empty --note or --repo clears it (a flag with no value reads as true, so it is not text)
    const changes = { title: text(opts.title), note: text(opts.note), repo: text(opts.repo) };
    if (changes.title === null && changes.note === null && changes.repo === null) {
      throw new Error('change something: --title, --note or --repo');
    }
    warnTypedRepo(home, changes.repo, process.cwd());
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
    warnTypedRepo(home, item.repo ? null : text(opts.repo), process.cwd());
    const started = store.start(item.id, {
      branch,
      repo: text(opts.repo) ?? item.repo ?? repoOfCheckout(process.cwd()),
      by: who,
    });
    return out(
      `${started.id} started on ${started.branch}: ${started.title}\n${claimHint(started.id)}`,
    );
  }
  if (verb === 'branch') {
    // the author renamed or switched its branch: the card's branch is what the board reads, and each open run of the card
    // keeps its own copy, so both move. The card is written first, then the runs: after a crash, running it again finishes
    const item = found();
    const branch = words[1];
    if (!branch) {
      throw new Error('a new branch is needed: once-upon backlog branch ID NEW-BRANCH');
    }
    if (item.landed_at) {
      throw new Error(`${item.id} is done: its work landed, so it has no branch to move`);
    }
    const registry = new AgentRegistry(home);
    const open = registry.agents().filter((one) => one.card === item.id && runIsOpen(one));
    let moved = 0;
    if (item.branch !== branch) {
      store.start(item.id, { branch, repo: item.repo, by: who });
    }
    for (const run of open) {
      if (run.branch !== branch) {
        registry.setBranch(run.name, branch, { sid: run.sid, run: run.run, by: who });
        moved++;
      }
    }
    if (item.branch === branch && !moved) {
      return out(`${item.id} already on ${branch}`);
    }
    return out(`${item.id} branch ${item.branch ?? 'none'} -> ${branch} (runs: ${moved})`);
  }
  if (verb === 'claim') {
    // the agent (named as the ledger names it) owns the card: the board links the two by this and nothing else. --branch
    // also starts the card on that branch, so it rides on the branch's work card
    const item = found();
    const agent = text(opts.agent);
    if (!agent) {
      throw new Error('whose card? pass --agent NAME, the name the agent has in the ledger');
    }
    // a run takes its card's repo (ADR-25), so a claim cannot move the card to another one
    const typedRepo = text(opts.repo);
    if (typedRepo && item.repo && !sameRepo(typedRepo, item.repo)) {
      throw new Error(
        `${item.id} is on ${item.repo}, not ${typedRepo}: edit the card's repo first`,
      );
    }
    // the claimer's full session is the editor's: its slots count the cards it claimed (state/src/queues/backlog/slots.ts). A worktree is
    // checked against git only when given: the author makes its worktree after the claim
    const worktree = text(opts.worktree);
    if (worktree) {
      const problem = claimWorktreeProblem(worktree, {
        repo: item.repo,
        branch: text(opts.branch) ?? item.branch,
      });
      if (problem) {
        throw new Error(problem);
      }
    }
    // --repo cannot differ from a card that has one (refused above); on a card with none it is kept by --branch's start
    warnTypedRepo(home, item.repo || !text(opts.branch) ? null : typedRepo, process.cwd());
    const claimed = store.claim(item.id, {
      agent,
      sid: text(opts.sid),
      session: ownSession(),
      worktree: worktree ? path.resolve(worktree) : null,
      by: who ?? agent,
    });
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
      registry.agents(),
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
  if (verb === 'someday') {
    const item = found();
    // the ledger says whether the card's claim is live (an agent working it)
    const maybe = store.someday(item.id, !opts.off, who, new AgentRegistry(home).agents());
    return out(
      maybe.someday
        ? `${maybe.id} someday: out of the main list, in the Someday section (backlog someday ${maybe.id} --off brings it back)`
        : `${maybe.id} back in the backlog, in its old place`,
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
    subs: [
      'add',
      'list',
      'show',
      'edit',
      'start',
      'claim',
      'branch',
      'adopt',
      'move',
      'done',
      'land',
      'hold',
      'someday',
      'drop',
      'reopen',
    ],
    usage: [
      '  once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME]  keep something for later: a card in the board\'s Backlog column',
      '  once-upon backlog edit ID [--title TEXT] [--note TEXT] [--repo owner/name]      change an open card in place (an empty --note or --repo clears it; a long note: --note-file PATH or --note -)',
      '  once-upon backlog list [--all] [--json] [--someday] | show ID | drop ID | reopen ID  the items in board order (open ones, or all), one item, drop one, or bring a dropped one back',
      '  once-upon backlog done ID [--sha SHA]                                            the work landed: the card goes to Done for an hour',
      '  once-upon backlog land [PICKED_SHA...] --from REF --to REF [--dry-run]           a deploy: mark done the cards whose recorded commit (agent finish --commit) is in the range',
      '  once-upon backlog adopt ID [--title TEXT]                                        an implicit card (a run that did not start in the backlog; list --implicit shows them) becomes a backlog card with the same id',
      '  once-upon backlog hold ID [--off]                                                the card lands by hand: a deploy never marks it done',
      '  once-upon backlog someday ID [--off]                                             maybe someday: out of the main list into a collapsed Someday section (list --someday shows it)',
      '  once-upon backlog move ID --before ID | --top | --bottom                        reorder: new items go to the bottom',
      "  once-upon backlog start ID [--branch NAME]                                       work began: the card moves onto that branch's work card",
      '  once-upon backlog branch ID NEW-BRANCH                                           the branch was renamed or switched: the card and its open runs move to it, so the board keeps its worktree and story',
      '  once-upon backlog claim ID --agent NAME [--sid SID8] [--branch NAME]            an agent takes the card: the board links card and agent only by this (--branch also starts it)',
      "                                                                                   it records the claimer's full session (the editor's, whose slots count its cards) and --worktree PATH, checked against git worktree list when given",
    ],
    run: backlog,
  },
];
