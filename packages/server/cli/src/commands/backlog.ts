/*
 * The backlog from the terminal: `once-upon backlog add|list|show|edit|start|claim|done|land|hold|skip-critic|someday|drop|reopen`. It reads and writes the backlog file
 * (state/src/queues/backlog/backlog.ts) in-process, so nothing goes over HTTP; the board shows the items as its Backlog column.
 */
import path from 'node:path';
import { formatTime, isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { repoOfCheckout, currentBranch, sameRepo } from '@once-upon-a-diff/foundation/repos';

import {
  BacklogStore,
  cardLookup,
  claimHint,
  isListed,
} from '@once-upon-a-diff/state/queues/backlog/backlog';
import { dropRunsProblem, runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import { claimWorktreeProblem } from '@once-upon-a-diff/state/queues/backlog/claim-worktree';
import { moveBranch } from '@once-upon-a-diff/core/features/runs/service';
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { landItems, recordedTips } from '@once-upon-a-diff/state/queues/backlog/landing';
import { liveCardIds } from '@once-upon-a-diff/state/queues/backlog/implicit';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { out } from '../output.ts';
import { cardRepoOf, warnTypedRepo } from '../typed-repo.ts';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon backlog add ("TITLE" | --title TEXT | --title-file PATH | --title -) [--note TEXT | --note-file PATH | --note -] [--repo owner/name] [--branch NAME] [--by NAME]\n' +
  '       once-upon backlog list [--all] [--json] [--someday] [--implicit]\n' +
  '       once-upon backlog adopt ID [--title TEXT] [--by NAME]\n' +
  '       once-upon backlog show ID\n' +
  '       once-upon backlog edit ID [--title TEXT] [--note TEXT | --note-file PATH | --note -] [--repo owner/name] [--story ID]\n' +
  '       once-upon backlog start ID [--branch NAME] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog claim ID --agent NAME [--sid SID8] [--branch NAME] [--worktree PATH] [--repo owner/name] [--by NAME]\n' +
  '       once-upon backlog branch ID NEW-BRANCH [--by NAME]\n' +
  '       once-upon backlog move ID --before ID | --top | --bottom\n' +
  '       once-upon backlog done ID [--sha SHA] [--by NAME]\n' +
  '       once-upon backlog land [PICKED_SHA...] --from REF --to REF [--by NAME] [--dry-run]\n' +
  '       once-upon backlog hold ID [--off]\n' +
  '       once-upon backlog skip-critic ID [--off]\n' +
  '       once-upon backlog someday ID [--off]\n' +
  '       once-upon backlog drop ID [--into CARD]\n' +
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

/** One call of `backlog VERB`: the store, the words after the verb and the lookups the verbs share. */
interface Call {
  home: string;
  opts: CliOpts;
  /** the words after the verb: an id, a title */
  words: string[];
  store: BacklogStore;
  who: string | null;
  /** the listed card the first word names (a card an agent made is refused with the way to adopt it) */
  found(): BacklogItem;
  /** the cards agents made (ADR-27, ADR-29): stored, but not listed in the backlog until adopted */
  implicit(): BacklogItem[];
  adoptCard(id: string | undefined, title: string | null, note?: string | null): AdoptedCard;
  adoptStarted(id: string | undefined, title: string | null, note?: string | null): BacklogItem;
}

type AdoptedCard = {
  card: BacklogItem;
  adopted: BacklogItem;
};

type Verb = (call: Call) => unknown;

function callOf(home: string, opts: CliOpts, words: string[]): Call {
  const store = new BacklogStore(home);
  const who = text(opts.by);
  const implicit = () =>
    store
      .items()
      .filter((one) => one.source === 'agent' && !isListed(one) && one.state !== 'dropped')
      .map((one) => ({ ...one, implicit: true as const }));
  const found = () => {
    const item = store.listed().find((one) => one.id === words[0]);
    if (item) {
      return item;
    }
    if (implicit().some((one) => one.id === words[0])) {
      throw new Error(
        `${words[0]} is a card an agent made (not listed in the backlog): once-upon backlog adopt ${words[0]} first`,
      );
    }
    throw new Error(`no backlog item ${words[0] || ''}`.trim());
  };
  // a card an agent made, listed in the backlog under its own id, as `adopt` and `drop` need it
  const adoptCard = (id: string | undefined, title: string | null, note?: string | null) => {
    if (store.listed().some((one) => one.id === id)) {
      throw new Error(`${id} is already a card`);
    }
    const card = implicit().find((one) => one.id === id);
    if (!card) {
      throw new Error(
        `no such card ${id ?? ''}: only a card an agent made (backlog list --implicit) can be adopted`.trim(),
      );
    }
    const adopted = store.adopt(card.id, { title, note, by: who ?? card.added_by });
    return { card, adopted };
  };
  // a card with a branch is started on it, as `claim --branch` does, so it reads as work done or under way: no Assign while its
  // author runs, and a built card on a branch reaches Ready instead of leaving the board. Start needs a branch, so a card with
  // none stays open in the Backlog (its runs still decide its column), and is not claimed: a claim with no branch would show
  // "claimed, pending" in Working for two hours with nobody on it. With a branch the card is claimed for its first run, so the
  // same author can start a fix round on it (an author on a card with no claim is refused)
  const adoptStarted = (id: string | undefined, title: string | null, note?: string | null) => {
    const { card, adopted } = adoptCard(id, title, note);
    if (card.branch) {
      const first = runsOf(card, new AgentRegistry(home).agents())[0];
      const adder = who ?? first?.name ?? card.added_by;
      store.start(adopted.id, { branch: card.branch, repo: card.repo, by: adder });
      // a card an author started already carries the claim its start wrote
      if (!card.claim && first) {
        store.claim(adopted.id, { agent: first.name, sid: first.sid, by: adder });
      }
    }
    return adopted;
  };
  return { home, opts, words, store, who, found, implicit, adoptCard, adoptStarted };
}

/** `adopt`: a card an agent made becomes a backlog card, with its own id: its runs already name it. */
function adopt({ opts, words, adoptStarted }: Call) {
  const adopted = adoptStarted(words[0], text(opts.title));
  return out(`${adopted.id} adopted: ${adopted.title}`);
}

/** The title is the words after `add`, or --title / --title-file / --title - (not both). */
function titleOf(opts: CliOpts, words: string[]): string {
  const flagged = text(opts.title);
  if (flagged !== null && words.length) {
    throw new Error('give the title as words or as --title, not both');
  }
  return flagged ?? words.join(' ');
}

/** The card an agent made that an `add` on this repo and branch would make: not listed yet, a run of it is open, and it is on the branch. */
function liveCardOn(call: Call, repo: string | null, branch: string | null) {
  if (!isFeatureBranch(branch)) {
    return undefined;
  }
  const live = liveCardIds(new AgentRegistry(call.home).agents(), Date.now());
  return call
    .implicit()
    .find(
      (card) =>
        live.has(card.id) &&
        card.branch === branch &&
        (repo ? sameRepo(card.repo, repo) : !card.repo),
    );
}

function add(call: Call) {
  const { home, opts, words, store, who } = call;
  const title = titleOf(opts, words);
  warnTypedRepo(home, text(opts.repo), process.cwd());
  // the checkout the command runs in names the repo unless --repo says otherwise
  const repo = cardRepoOf(home, text(opts.repo), process.cwd()) ?? repoOfCheckout(process.cwd());
  const branch = text(opts.branch);
  // work and its card are one card: a card an agent made with a run open on this repo and branch is the card this add would make,
  // so it is adopted with this title and note (as `adopt` does) and no second card is written. A card whose runs are all over
  // is earlier work on a reused branch name: this one is its own
  const live = liveCardOn(call, repo, branch);
  if (live) {
    const joined = call.adoptStarted(live.id, title, text(opts.note));
    return out(
      `${joined.id} added: ${joined.title} (joined the implicit card for ${branch}, so its runs are on it)`,
    );
  }
  const item = store.add({ title, note: text(opts.note), repo, branch, by: who });
  return out(`${item.id} added: ${item.title}`);
}

const numbered = (items: BacklogItem[], home: string): string[] =>
  items.map((item, index) => `${index + 1}\t${describe(item, home)}`);

/** `list --implicit`: only the implicit cards, the live ones (a run open), or every one with --all. */
function listImplicit({ home, opts, implicit }: Call) {
  const live = liveCardIds(new AgentRegistry(home).agents(), Date.now());
  const cards = implicit().filter((item) => opts.all || live.has(item.id));
  if (opts.json) {
    return out(JSON.stringify(cards, null, 2));
  }
  return out(cards.length ? numbered(cards, home).join('\n') : 'No implicit cards.');
}

/** The cards `list` prints: the main list, the Someday section only with --someday, everything with --all (someday cards marked in place). */
function listedItems(opts: CliOpts, all: BacklogItem[], later: BacklogItem[]): BacklogItem[] {
  if (opts.someday) {
    return later;
  }
  return opts.all ? all : all.filter((item) => !item.someday);
}

function list(call: Call) {
  const { home, opts, store, implicit } = call;
  if (opts.implicit) {
    return listImplicit(call);
  }
  const all = store.listed().filter((item) => opts.all || reported(item) === 'open');
  // the Someday section is collapsed: out of the main list, and printed (expanded) only by --someday
  const later = all.filter((item) => item.someday);
  const items = listedItems(opts, all, later);
  // --all is every card, the implicit ones too (marked)
  const shownItems = opts.all && !opts.someday ? [...items, ...implicit()] : items;
  if (opts.json) {
    return out(JSON.stringify(shownItems.map(shown), null, 2));
  }
  // in the board's order, numbered
  const lines = numbered(shownItems, home);
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

function show({ words, implicit, found }: Call) {
  const card = implicit().find((one) => one.id === words[0]);
  return out(JSON.stringify(shown(card ?? found()), null, 2));
}

function edit({ home, opts, store, who, found }: Call) {
  const item = found();
  // a flag left out stays; an empty --note, --repo or --story clears it (a flag with no value reads as true, so it is not text)
  const changes = {
    title: text(opts.title),
    note: text(opts.note),
    repo: text(opts.repo),
    story: text(opts.story),
  };
  if (Object.values(changes).every((value) => value === null)) {
    throw new Error('change something: --title, --note, --repo or --story');
  }
  warnTypedRepo(home, changes.repo, process.cwd());
  const edited = store.edit(
    item.id,
    {
      title: changes.title ?? undefined,
      note: changes.note ?? undefined,
      repo: cardRepoOf(home, changes.repo, process.cwd()) ?? undefined,
      story: changes.story ?? undefined,
    },
    who,
  );
  return out(`${edited.id} edited: ${edited.title}`);
}

/** The branch the work starts on: --branch, the card's own, or the branch the session is on unless it is a default branch. */
function startBranch(opts: CliOpts, item: BacklogItem): string | null {
  const typed = text(opts.branch) ?? item.branch;
  if (typed !== null) {
    return typed;
  }
  const current = currentBranch(process.cwd());
  return isFeatureBranch(current) ? current : null;
}

function start({ home, opts, store, who, found }: Call) {
  const item = found();
  // the branch the session is on, unless it is a default branch (then the work has no branch yet: say which)
  const branch = startBranch(opts, item);
  if (!branch) {
    throw new Error('this checkout is not on a work branch: pass --branch NAME');
  }
  warnTypedRepo(home, item.repo ? null : text(opts.repo), process.cwd());
  const started = store.start(item.id, {
    branch,
    repo:
      cardRepoOf(home, text(opts.repo), process.cwd()) ??
      item.repo ??
      repoOfCheckout(process.cwd()),
    by: who,
  });
  return out(
    `${started.id} started on ${started.branch}: ${started.title}\n${claimHint(started.id)}`,
  );
}

/** `branch ID NEW`: the author renamed or switched its branch. */
function branch({ home, words, who, found }: Call) {
  // the card's branch is what the board reads, and each open run of the card keeps its own copy, so both move. The card is
  // written first, then the runs: after a crash, running it again finishes
  const item = found();
  const moved = moveBranch(home, item.id, words[1], who);
  if (moved.unchanged) {
    return out(`${moved.id} already on ${moved.to}`);
  }
  return out(
    `${moved.id} branch ${moved.from ?? 'none'} -> ${moved.to} (runs: ${moved.runsMoved})`,
  );
}

/** A claim takes the card's repo (ADR-25), so it cannot move the card to another one; a --worktree is checked against git when given. */
function checkClaim(item: BacklogItem, opts: CliOpts): void {
  const typedRepo = text(opts.repo);
  if (typedRepo && item.repo && !sameRepo(typedRepo, item.repo)) {
    throw new Error(`${item.id} is on ${item.repo}, not ${typedRepo}: edit the card's repo first`);
  }
  // the claimer's full session is the editor's: its slots count the cards it claimed (state/src/queues/backlog/slots.ts). A worktree is
  // checked against git only when given: the author makes its worktree after the claim
  const worktree = text(opts.worktree);
  const problem =
    worktree &&
    claimWorktreeProblem(worktree, { repo: item.repo, branch: text(opts.branch) ?? item.branch });
  if (problem) {
    throw new Error(problem);
  }
}

function claim({ home, opts, store, who, found }: Call) {
  // the agent (named as the ledger names it) owns the card: the board links the two by this and nothing else. --branch
  // also starts the card on that branch, so it rides on the branch's work card
  const item = found();
  const agent = text(opts.agent);
  if (!agent) {
    throw new Error('whose card? pass --agent NAME, the name the agent has in the ledger');
  }
  checkClaim(item, opts);
  const typedRepo = text(opts.repo);
  const branch = text(opts.branch);
  const worktree = text(opts.worktree);
  // --repo cannot differ from a card that has one (refused above); on a card with none it is kept by --branch's start
  warnTypedRepo(home, item.repo || !branch ? null : typedRepo, process.cwd());
  const claimed = store.claim(item.id, {
    agent,
    sid: text(opts.sid),
    session: ownSession(),
    worktree: worktree ? path.resolve(worktree) : null,
    by: who ?? agent,
  });
  if (branch) {
    store.start(item.id, {
      branch,
      repo:
        cardRepoOf(home, typedRepo, process.cwd()) ?? claimed.repo ?? repoOfCheckout(process.cwd()),
      by: who ?? agent,
    });
  }
  return out(
    `${item.id} claimed by ${agent}${branch ? `, started on ${branch}` : ''}: ${item.title}`,
  );
}

function move({ opts, store, who, found }: Call) {
  const item = found();
  const before = text(opts.before);
  if (!before && !opts.top && !opts.bottom) {
    throw new Error('move it --before ID, --top or --bottom');
  }
  const edge = opts.top ? 'top' : 'bottom';
  store.move(item.id, before ? { before } : { edge }, who);
  return out(`${item.id} moved ${before ? `before ${before}` : `to the ${edge}`}: ${item.title}`);
}

function done({ opts, words, store, who, found }: Call) {
  // by id: the work landed. A deploy marks cards by the commit each recorded (`land`), never by a branch name
  if (!words[0] || opts.branch) {
    throw new Error('mark an item done by ID: once-upon backlog done ID [--sha SHA]');
  }
  const landed = store.done(found().id, { sha: text(opts.sha), by: who });
  return out(
    `${landed.id} done${landed.landed_sha ? ` at ${landed.landed_sha}` : ''}: ${landed.title}`,
  );
}

/** `land`: what deploy-local.sh runs after a deploy: --from the live commit before it, --to the deployed tip, and a batch deploy's picked shas as words. The checkout is the one the command runs in. */
function land({ home, opts, words, store, who }: Call) {
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
    store.listed(),
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
}

function hold({ opts, store, who, found }: Call) {
  const held = store.hold(found().id, !opts.off, who);
  return out(
    held.hold
      ? `${held.id} held: neither a deploy nor a merged PR will mark it done, only backlog done ${held.id} does`
      : `${held.id} released: a deploy or a merged PR can mark it done again`,
  );
}

function skipCritic({ opts, store, who, found }: Call) {
  const skipped = store.skipCritic(found().id, !opts.off, who);
  return out(
    skipped.critic_skipped
      ? `${skipped.id} critic skipped: once its work is built it reads Ready, with no critic needed`
      : `${skipped.id} critic needed again: once its work is built it waits for a passing critic or a skip`,
  );
}

function someday({ home, opts, store, who, found }: Call) {
  const item = found();
  // the ledger says whether the card's claim is live (an agent working it)
  const maybe = store.someday(item.id, !opts.off, who, new AgentRegistry(home).agents());
  return out(
    maybe.someday
      ? `${maybe.id} someday: out of the main list, in the Someday section (backlog someday ${maybe.id} --off brings it back)`
      : `${maybe.id} back in the backlog, in its old place`,
  );
}

/** Why a card cannot be dropped into `into`, or null: its runs stay on their own repo's cards, and a closed card takes none. */
function dropIntoProblem(
  item: BacklogItem,
  into: string,
  stored: ReturnType<ReturnType<typeof cardLookup>>,
  target: { repo: string | null } | null,
): string | null {
  if (into === item.id) {
    return `${item.id} cannot be dropped into itself`;
  }
  if (item.state === 'dropped') {
    return `${item.id} is already dropped`;
  }
  if (!target) {
    return `no card ${into}: drop ${item.id} into a backlog card or an implicit card`;
  }
  if (stored?.closed) {
    return `${into} is ${stored.closed}: it takes no runs, so drop ${item.id} into another card`;
  }
  if (item.repo && target.repo && !sameRepo(item.repo, target.repo)) {
    return `${item.id} is on ${item.repo} and ${into} on ${target.repo}: runs stay on their own repo's cards`;
  }
  return null;
}

function drop(call: Call) {
  const { opts, words, store, who, implicit, found } = call;
  // an implicit card that was never adopted is only its runs: a drop with no --into takes it (adopted first, then dropped).
  // A card with an open run is refused: it would be left on no card
  const registry = new AgentRegistry(call.home);
  const agents = registry.agents();
  const fresh = implicit().find((one) => one.id === words[0]);
  const item = fresh ?? found();
  const into = text(opts.into);
  if (!into) {
    const problem = dropRunsProblem(item, agents);
    if (problem) {
      throw new Error(problem);
    }
    const dropped = fresh ? call.adoptCard(item.id, null).adopted : item;
    store.drop(dropped.id, who);
    return out(`${dropped.id} dropped: ${dropped.title}`);
  }
  // --into: its runs move to another card first, then the card goes. The runs are moved one event each, so a failure
  // part-way leaves the card undropped and running it again moves what is left
  const stored = cardLookup(store)(into);
  const problem = dropIntoProblem(
    item,
    into,
    stored,
    stored ?? implicit().find((one) => one.id === into) ?? null,
  );
  if (problem) {
    throw new Error(problem);
  }
  const runs = runsOf(item, agents);
  for (const run of runs) {
    registry.setCard(run, into, { by: who ?? undefined });
  }
  if (!fresh) {
    store.drop(item.id, who);
  }
  return out(
    `${item.id} dropped: ${item.title} (moved ${runs.length} run${runs.length === 1 ? '' : 's'} onto ${into})`,
  );
}

function reopen({ store, who, found }: Call) {
  const item = found();
  store.reopen(item.id, who);
  return out(`${item.id} reopened: ${item.title}`);
}

/** `backlog VERB`: one function per verb. */
const VERBS: Record<string, Verb> = {
  adopt,
  add,
  list,
  show,
  edit,
  start,
  branch,
  claim,
  move,
  done,
  land,
  hold,
  'skip-critic': skipCritic,
  someday,
  drop,
  reopen,
};

function backlog(home: string, _cfg: Config, opts: CliOpts) {
  const [verb = '', ...words] = opts._ || [];
  if (!Object.hasOwn(VERBS, verb)) {
    throw new Error(USAGE);
  }
  return VERBS[verb](callOf(home, opts, words));
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
      'skip-critic',
      'someday',
      'drop',
      'reopen',
    ],
    usage: [
      '  once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME]  keep something for later: a card in the board\'s Backlog column',
      '  once-upon backlog edit ID [--title TEXT] [--note TEXT] [--repo owner/name] [--story ID]  change an open card in place (an empty --note, --repo or --story clears it; a long note: --note-file PATH or --note -; --story links its story, for a repair)',
      '  once-upon backlog list [--all] [--json] [--someday] | show ID | drop ID [--into CARD] | reopen ID  the items in board order (open ones, or all), one item, drop one (an implicit card too; a card with an open run needs --into CARD, which moves it first), or bring a dropped one back',
      '  once-upon backlog done ID [--sha SHA]                                            the work landed: the card goes to Done for an hour',
      '  once-upon backlog land [PICKED_SHA...] --from REF --to REF [--dry-run]           a deploy: mark done the cards whose recorded commit (agent finish --commit) is in the range (a repo with no deploy lands by merged PR: the bridge does it)',
      '  once-upon backlog adopt ID [--title TEXT]                                        an implicit card (a run that did not start in the backlog; list --implicit shows them) becomes a backlog card with the same id',
      '  once-upon backlog hold ID [--off]                                                the card lands by hand: a deploy or a merged PR never marks it done',
      '  once-upon backlog skip-critic ID [--off]                                         the card needs no critic: built with none passing it is Ready for your review, not Waiting',
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
