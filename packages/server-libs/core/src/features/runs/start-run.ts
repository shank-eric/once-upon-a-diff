/*
 * Starts a run on a card, in one place (ADR-25). The CLI's `agent start` parses its flags into a RunStartInput and calls this;
 * a later dispatch can call it with no CLI types. It owns everything that decides whether a start is allowed and what it is
 * stamped with: the role table, the flags a card refuses, the PR's head branch, the card's stamp, and the typed-repo warning.
 *
 * Write order: a card this start makes (a run with no card is its own, ADR-27 and ADR-29) is stored first, then the run, then
 * what the run teaches an existing card. The registry refuses a start before it writes, so a refused start leaves an existing
 * card as it was, and a made one idle and hidden (nothing lists a card an agent made until it is adopted). The two files have two
 * locks and no lock spans both: if the stamp fails after the run is written, the error says so and names
 * `once-upon backlog branch`, which is idempotent and repairs it.
 */
import {
  REPO_RE,
  canonicalCasing,
  repoOfCheckout,
  typedRepoNote,
} from '@once-upon-a-diff/foundation/repos';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { BACKLOG_NOTE_MAX } from '@once-upon-a-diff/terms/text';
import { prHeadBranch } from '@once-upon-a-diff/foundation/gh';
import { canonicalKind } from '@once-upon-a-diff/state/records/agents/events';
import type { AgentKind } from '@once-upon-a-diff/state/records/agents/agent-types';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import {
  flagsBesideCard,
  flagsBesideCardError,
  type AgentRegistry,
} from '@once-upon-a-diff/state/records/agents/registry';
import {
  BacklogStore,
  cardLookup,
  type LinkInput,
} from '@once-upon-a-diff/state/queues/backlog/backlog';
import { newId, newRunId } from '@once-upon-a-diff/foundation/ids';
import { cardsOnBranch, ensureCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import { implicitTitle } from '@once-upon-a-diff/state/records/agents/implicit';
import { SESSION_RE } from '@once-upon-a-diff/terms/patterns';
import { isAbsolute } from 'node:path';
import { worktreeFacts } from '@once-upon-a-diff/adapters/git';
import { SELF_PREFIX, isSelfName } from '@once-upon-a-diff/terms/ids';
import { runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { mainCheckout } from './checkout.ts';
import { roundBaseOf, type RoundBase } from './round.ts';
import { trustedLiveSids } from './live-sids.ts';
import { liveWrites } from './live-writes.ts';
import { roleKind, selfProblem } from './roles.ts';
import { runRegistry, type Mirror } from './registry.ts';
import { relatedRuns, type RelatedRun } from './related-runs.ts';

/** What a start is asked for, as typed: strings that are empty count as absent. */
export interface RunStartInput {
  /** left out with `self`: the run is named `self-` and a fresh suffix */
  name: string;
  /** a parent session's own run (`agent start --self`): its sid and session are the caller's, its name is minted here */
  self?: boolean;
  sid?: string | null;
  /** the launching session's full id; the caller reads it (this never reads the environment) */
  session?: string | null;
  kind?: string | null;
  role?: string | null;
  /** absent carries over from the earlier run */
  standing?: boolean;
  task: string;
  model?: string | null;
  effort?: string | null;
  repo?: string | null;
  branch?: string | null;
  pr?: string | null;
  /** the checkout the run works in; names the repo unless `repo` says otherwise */
  cwd: string;
  card?: string | null;
  newCard?: boolean;
  replaces?: string | null;
  lane?: string | null;
  notes?: string | null;
  by?: string | null;
  slots?: unknown;
  /** when the run began, for a run recorded after the fact (`recordFix`); absent: now */
  at?: Date;
}

export interface RunIo {
  warn?: (line: string) => void;
  mirror?: Mirror;
  /** the PR's head branch; defaults to asking gh. The seam core's tests use */
  prHead?: (repo: string, pr: number) => Promise<string | null>;
  /** the live sessions (first 8 of each id) the sweep ends a gone session's self run by; defaults to the registry's, and none closes nothing */
  liveSids?: () => Promise<string[]>;
}

export interface StartedRun {
  id: string;
  run: string;
  card: string | null;
  /** the branch (and repo) the card was stamped with, when it had none */
  stamped: { branch: string; repo: string | null } | null;
  /** the open card on the run's branch that this start joined, instead of making its own; null when it made one or named one */
  joined: { card: string; title: string; branch: string } | null;
  /** the session's earlier recent no-card runs, when this start made a card of its own beside them; empty otherwise (see related-runs.ts) */
  related: RelatedRun[];
  /** whether --new-card would be taken on this start: a critic or fixer (by role or kind) works on a card, so it never is */
  newCardAllowed: boolean;
  /** the card's later review round (new commits on top of a push) this run is in, with the pushed tip it starts from; null in a first round */
  round: RoundBase | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * The checkout a run works in, when it is a checkout of the branch the run is on: that is the card's worktree. A dispatched
 * author starts in the main checkout (it makes its worktree after), so a folder on another branch is not the work's.
 */
const worktreeOn = (cwd: string, branch: string | null): string | null =>
  branch && isAbsolute(cwd) && worktreeFacts(cwd)?.branch === branch ? cwd : null;

type Item = ReturnType<BacklogStore['items']>[number];
type Stamp = { branch: string; repo: string | null };

/** What every step of a start reads: the input, as typed, and what the steps share of it. */
interface Start {
  home: string;
  input: RunStartInput;
  warn: (line: string) => void;
  store: BacklogStore;
  lookup: ReturnType<typeof cardLookup>;
  name: string;
  card: string | null;
  role: string | null;
  kind: string | null;
  typedPr: string | null;
  typedBranch: string | null;
  sid: string;
  /** the open card on the run's branch that a critic or fixer with no --card was put on */
  joinedCard?: NonNullable<StartedRun['joined']>;
}

/** A card that is not landed or dropped. */
const isLive = (item: Item): boolean => item.state !== 'dropped' && !item.landed_at;

/** An open card with no branch yet: a start that names a branch (or a PR with one) stamps the card with it. */
function needsBranch<T extends { closed?: unknown; branch?: unknown }>(
  item: T | null | undefined,
): item is T {
  return !!item && !item.closed && !item.branch;
}

/** A name that is a session's own run, or an editor, is refused: those register another way. */
function refuseOtherRegistration(input: RunStartInput): void {
  if (input.self) {
    const problem = selfProblem(input);
    if (problem) {
      throw new Error(problem);
    }
  } else if (isSelfName(input.name)) {
    throw new Error(
      `the name ${input.name} is a session’s own run: register it with agent start --self`,
    );
  }
  // an editor is not an agent: it registers through `editor start`, where its slots are required
  if (canonicalKind(text(input.kind)) === 'editor' || input.slots !== undefined) {
    throw new Error('register an editor with: once-upon editor start --slots N');
  }
}

/**
 * A run on a card takes its repo and branch from the card, and what it does from --role: the typed ones are refused
 * (ADR-25, the flip), all named at once, before anything is written. An unknown card is the registry's to refuse.
 */
function refuseFlagsBesideCard(run: Start): void {
  const { input, card } = run;
  if (!card) {
    return;
  }
  const flags = [
    ...(input.kind == null ? [] : ['--kind']),
    ...flagsBesideCard(run.lookup(card) ?? { repo: null, branch: null }, {
      repo: text(input.repo),
      branch: run.typedBranch,
      pr: run.typedPr,
      lane: text(input.lane),
    }),
  ];
  if (flags.length) {
    throw flagsBesideCardError(flags);
  }
}

/** A run that works on a card it did not make: a critic or fixer by role, or a critic by kind (`--kind reviewer` with no role). */
const joinsByBranch = ({ role, kind }: Pick<Start, 'role' | 'kind'>): boolean =>
  role === 'critic' || role === 'fixer' || canonicalKind(kind) === 'critic';

/**
 * A critic or fixer works on a card: one with no --card but a --branch (or a checkout of a feature branch) is on the open card
 * that branch has, and the card gives the branch and repo from here on. Several open cards are the run's to choose between,
 * and none leaves the missing card for refuseNoWork to say.
 */
function joinCardOfBranch(run: Start): void {
  const { input } = run;
  if (run.card || !joinsByBranch(run)) {
    return;
  }
  // a critic or fixer never makes a card, so --new-card has nothing to do for it: say so, not drop it
  if (input.newCard) {
    throw new Error(
      `a ${run.role ?? 'critic'} works on an existing card, so --new-card is not taken: pass --card ID`,
    );
  }
  const branch = run.typedBranch ?? worktreeFacts(input.cwd)?.branch ?? null;
  const repo = text(input.repo) ?? repoOfCheckout(input.cwd);
  const found =
    branch && !run.typedPr
      ? onlyCardOn(run, repo && REPO_RE.test(repo) ? repo : null, branch)
      : undefined;
  if (!found) {
    return;
  }
  run.card = found.id;
  run.typedBranch = null;
  run.joinedCard = { card: found.id, title: found.title, branch: found.branch ?? '' };
  // the lane is the repo's from here on: dropped with a warning, as on any joined run, not refused beside the card
  if (text(input.lane)) {
    run.warn('once-upon: --lane is ignored: a run’s lane is its repo’s');
  }
  run.input = { ...input, repo: null, lane: null };
}

/** The roles that need work to read, and the run a story agent's name gives away. */
function refuseNoWork(run: Start): void {
  const { role, card, typedPr, typedBranch, name } = run;
  // (a storyteller reads a PR or a branch, so either names its work with no card: the board joins it by that)
  const namesWork = !!(card || typedPr || typedBranch);
  if (role === 'storyteller' && !namesWork) {
    throw new Error('a storyteller needs --pr N, --branch NAME or --card ID');
  }
  if (joinsByBranch(run) && !card) {
    throw new Error(`a ${role ?? 'critic'} works on a card: pass --card ID`);
  }
  // a story run with no role, PR, branch or card is a card of its own that no PR story can match (the board shows two
  // cards for one PR): the skill names story agents story-<id>, so the shape is caught here, by name
  if (!role && !namesWork && /^story-/.test(name)) {
    throw new Error('a story run needs --role storyteller with --pr N (or --branch NAME)');
  }
}

/** The repo typed on a start, in the casing the checkout's origin or the other cards use (null when none was typed). */
function typedRepoCasing(input: RunStartInput, store: BacklogStore): string | null {
  return canonicalCasing(text(input.repo), {
    origin: repoOfCheckout(input.cwd),
    cardRepos: store.listed().map((item) => item.repo),
  });
}

/** Reads the input into a Start, refusing the shapes that no card or registry could make sense of. */
function beginStart(home: string, input: RunStartInput, warn: Start['warn']): Start {
  refuseOtherRegistration(input);
  const store = new BacklogStore(home);
  const role = text(input.role);
  const start: Start = {
    home,
    // a typed repo is kept in the spelling the checkout's origin or the other cards use
    input: { ...input, repo: typedRepoCasing(input, store) },
    warn,
    store,
    lookup: cardLookup(store),
    name: input.self ? `${SELF_PREFIX}${newRunId().slice(2, 8)}` : input.name,
    card: text(input.card),
    role,
    kind: roleKind(role, text(input.kind)),
    typedPr: text(input.pr),
    typedBranch: text(input.branch),
    sid: text(input.sid) ?? input.session?.slice(0, 8) ?? '',
  };
  refuseFlagsBesideCard(start);
  joinCardOfBranch(start);
  refuseNoWork(start);
  return start;
}

/** The PR's head branch, or null (with a warning) when gh cannot say; a storyteller with no card has nothing else to read, so it is refused. */
async function askPrHead(run: Start, repo: string | null, options: RunIo): Promise<string | null> {
  try {
    if (!repo) {
      throw new Error('no repo to ask about (--repo owner/name)');
    }
    const head = await (options.prHead ?? prHeadBranch)(repo, Number(run.typedPr));
    if (!head) {
      throw new Error('it has no head branch');
    }
    return head;
  } catch (err) {
    const why = `gh could not read #${run.typedPr}: ${(err as Error).message}`;
    if (run.role === 'storyteller' && !run.card) {
      throw new Error(`${why}; pass --branch NAME`);
    }
    run.warn(`once-upon: ${why}`);
    return null;
  }
}

/**
 * --pr and no --branch: the PR's head branch is the run's branch, and a card that has none gets it too, so the board joins
 * the run, the card, the PR and the story by one branch. gh being down is no reason to refuse a start, except for a
 * storyteller: with no branch it has nothing to read.
 */
async function branchOfPr(
  run: Start,
  options: RunIo,
): Promise<{ branch: string | null; pr: string | null; stamp: Stamp | null }> {
  const { card } = run;
  const typed = { branch: run.typedBranch, pr: run.typedPr, stamp: null };
  if (!run.typedPr || run.typedBranch) {
    return typed;
  }
  const item = card ? run.lookup(card) : null;
  if (card && !needsBranch(item)) {
    return typed;
  }
  const repo = (card ? item?.repo : null) ?? text(run.input.repo) ?? repoOfCheckout(run.input.cwd);
  const head = await askPrHead(run, repo, options);
  if (!head) {
    return typed;
  }
  // the registry cannot write the backlog: the run starts on the typed branch, and the card is stamped once the run is
  // accepted, so a refused start leaves the card as it was
  return card
    ? { branch: head, pr: null, stamp: { branch: head, repo } }
    : { ...typed, branch: head };
}

/** A typed --branch on an open card with no branch stamps the card too. */
function stampOfBranch(run: Start): Stamp | null {
  const item = run.card ? run.lookup(run.card) : null;
  if (!run.typedBranch || !needsBranch(item)) {
    return null;
  }
  return {
    branch: run.typedBranch,
    repo: item.repo ?? text(run.input.repo) ?? repoOfCheckout(run.input.cwd),
  };
}

/**
 * A repo typed on a run that has no card (or whose card has no repo yet, so the typed one is kept) is checked; a run on a
 * card that has a repo takes the card's, and the registry already says so.
 */
function warnTypedRepo(run: Start): void {
  const typedRepo = text(run.input.repo);
  const cardHasRepo = !!(run.card && run.lookup(run.card)?.repo);
  if (!typedRepo || cardHasRepo) {
    return;
  }
  const note = typedRepoNote(run.home, typedRepo, {
    cardRepos: run.store.listed().map((item) => item.repo),
    origin: repoOfCheckout(run.input.cwd),
  });
  if (note) {
    run.warn(`once-upon: ${note}`);
  }
}

/** What the registry is asked to start. */
function startInputOf(
  run: Start,
  placed: { branch: string | null; pr: string | null },
): Parameters<AgentRegistry['start']>[0] {
  const { input, card } = run;
  return {
    name: run.name,
    sid: run.sid,
    session: input.session,
    kind: (run.kind ?? undefined) as AgentKind | undefined,
    standing: input.standing,
    task: input.task,
    model: text(input.model),
    effort: text(input.effort),
    // the checkout the agent works in names the repo unless --repo says otherwise; a run on a card takes the card's
    repo: text(input.repo) ?? (card ? null : repoOfCheckout(input.cwd)),
    branch: placed.branch,
    pr: placed.pr,
    cwd: input.cwd,
    card,
    newCard: !!input.newCard,
    replaces: text(input.replaces),
    role: run.role as NonNullable<Parameters<AgentRegistry['start']>[0]['role']> | null,
    lane: text(input.lane),
    notes: text(input.notes),
    by: text(input.by),
    ...(input.at ? { at: input.at } : {}),
  };
}

/** The card a start joined, and what to write to it once the start is accepted. */
interface Join {
  joined: NonNullable<StartedRun['joined']>;
  /** what the card lacked, which the join teaches it; null when the card was just made */
  link: Pick<LinkInput, 'repo' | 'branch' | 'worktree' | 'session'> | null;
}

/** The one open card on the branch, none, or a refusal when several are (the run names its own with --card). */
function onlyCardOn(run: Start, repo: string | null, branch: string): Item | undefined {
  const cards = cardsOnBranch(run.store.items(), repo, branch);
  if (cards.length > 1) {
    throw new Error(
      `${cards.length} open cards are on ${branch} (${cards.map((one) => one.id).join(', ')}): pass --card ID to say which`,
    );
  }
  return cards[0];
}

/**
 * The open stored card on the branch: finding it writes nothing, so a start the registry then refuses leaves the card as it was.
 */
function openCardOn(run: Start, repo: string | null, branch: string): Join | null {
  const open = onlyCardOn(run, repo, branch);
  if (!open) {
    return null;
  }
  const sessionOk = !!run.input.session && SESSION_RE.test(run.input.session);
  return {
    joined: { card: open.id, title: open.title, branch: open.branch ?? '' },
    link: {
      repo: open.repo ? null : repo,
      branch: open.branch ? null : branch,
      worktree: open.worktree ? null : worktreeOn(run.input.cwd, branch),
      session: open.session || !sessionOk ? null : run.input.session,
    },
  };
}

/**
 * Makes the card this run is the start of. The find above and the make are one step in ensureCard, so two starts on one branch
 * make one card: a start that joined this card between the find and the make is joined and linked.
 */
function makeCard(
  run: Start,
  id: string,
  repo: string | null,
  branch: string | null,
  joinable: string | null,
): Join | null {
  const task = run.input.task.trim();
  const title = implicitTitle(task) || run.name;
  const sessionOk = !!run.input.session && SESSION_RE.test(run.input.session);
  const made = ensureCard(run.store, {
    id,
    source: 'agent',
    title,
    note: task && task !== title ? task.slice(0, BACKLOG_NOTE_MAX) : null,
    repo,
    branch,
    worktree: worktreeOn(run.input.cwd, branch),
    session: sessionOk ? run.input.session : null,
    by: run.name.slice(0, 40),
    joinBranch: !!joinable,
  });
  return made.joined
    ? {
        joined: { card: made.item.id, title: made.item.title, branch: made.item.branch ?? '' },
        link: null,
      }
    : null;
}

/** A run on the card it joined: the card gives the repo and branch, which the registry refuses beside a card. */
function runOnJoinedCard(
  run: Start,
  startInput: Parameters<AgentRegistry['start']>[0],
  card: string,
): void {
  startInput.card = card;
  startInput.repo = null;
  startInput.branch = null;
  startInput.pr = null;
  // a lane is dropped with a warning, as on a run that makes its card (the registry refuses one beside a card)
  if (startInput.lane) {
    run.warn('once-upon: --lane is ignored: a run’s lane is its repo’s');
    startInput.lane = null;
  }
}

/** The card the start made or joined: `minted` when the registry is to make it, `join` when it joined an open one. */
interface CardPlan {
  minted: string | null;
  join: Join | null;
}

/**
 * A run with no card makes its own (the registry mints its id): the card is stored first, with that id, so the run row and
 * the card agree. An author with no branch is refused by the registry, so nothing is stored for it. A run on a branch whose
 * card is still open (a story, a finished author run, a card not landed or dropped) joins that card instead, unless
 * --new-card.
 */
function planCard(
  run: Start,
  registry: AgentRegistry,
  startInput: Parameters<AgentRegistry['start']>[0],
  branch: string | null,
): CardPlan {
  if (!registry.wouldMint(startInput) || (run.kind === 'author' && !branch)) {
    return { minted: null, join: null };
  }
  const minted = newId('bl');
  const repo = startInput.repo;
  const cardRepo = repo && REPO_RE.test(repo) ? repo : null;
  const joinable = !run.input.newCard && isFeatureBranch(branch) ? branch : null;
  const found =
    (joinable ? openCardOn(run, cardRepo, joinable) : null) ??
    makeCard(run, minted, cardRepo, branch, joinable);
  if (!found) {
    return { minted, join: null };
  }
  runOnJoinedCard(run, startInput, found.joined.card);
  return { minted: null, join: found };
}

/** Asks the registry to start the run; a start that joined a card with an open author says how to make another. */
function registryStart(
  run: Start,
  registry: AgentRegistry,
  startInput: Parameters<AgentRegistry['start']>[0],
  plan: CardPlan,
  branch: string | null,
): ReturnType<AgentRegistry['start']> {
  try {
    return registry.start({ ...startInput, mintedCard: plan.minted }, run.warn);
  } catch (err) {
    if (plan.join && /already has an open author run/.test((err as Error).message)) {
      throw new Error(
        `${(err as Error).message} (${branch} already has the open card ${plan.join.joined.card}; --new-card starts another)`,
      );
    }
    throw err;
  }
}

/** Whether the run works in a checkout of its own: an author or a fixer, or a run of the author kind with no role. */
const worksInWorktree = (role: string | null, kind: string | null): boolean =>
  ['author', 'fixer'].includes(role ?? '') || (kind === 'author' && !role);

/**
 * What the run teaches its card: the checkout an author or fixer works in, and a branch or repo the card lacked (a card an
 * agent made is not started by it: only a backlog card is, `store.start`). Returns the card the run is on.
 */
function teachCard(
  run: Start,
  started: ReturnType<AgentRegistry['start']>,
  stamp: Stamp | null,
  placed: { branch: string | null; repo: string | null },
): Item | undefined {
  const onCard = started.card
    ? run.store.items().find((one) => one.id === started.card)
    : undefined;
  if (!onCard || !isLive(onCard) || onCard.source === 'backlog') {
    return onCard;
  }
  run.store.link(onCard.id, {
    branch: stamp?.branch ?? (onCard.branch ? null : placed.branch),
    repo: onCard.repo ? null : (stamp?.repo ?? placed.repo),
    worktree: worksInWorktree(run.role, run.kind)
      ? worktreeOn(run.input.cwd, onCard.branch ?? stamp?.branch ?? placed.branch)
      : null,
    by: text(run.input.by),
  });
  return onCard;
}

/** The run is on a backlog card, or a card an agent made that the run did not find: the stamp starts a backlog card on the branch. */
function stampBacklogCard(
  run: Start,
  stamp: Stamp,
  started: { id: string },
  onCard: Item | undefined,
): void {
  const { card } = run;
  if (!card || (onCard && onCard.source !== 'backlog')) {
    return;
  }
  try {
    run.store.start(card, { ...stamp, by: text(run.input.by) });
  } catch (err) {
    throw new Error(
      `run ${started.id} started, but ${card} could not be stamped with ${stamp.branch} (${(err as Error).message}): once-upon backlog branch ${card} ${stamp.branch} repairs it`,
    );
  }
}

/** The session's earlier no-card runs, for a start that made its own card (not --card, a join, --new-card or --self). */
function relatedOf(
  run: Start,
  agents: LedgerAgent[],
  startInput: Parameters<AgentRegistry['start']>[0],
  plan: CardPlan,
): RelatedRun[] {
  const isOwnCardStart = !!plan.minted && !run.joinedCard && !run.input.self && !run.input.newCard;
  if (!isOwnCardStart || !run.sid) {
    return [];
  }
  return relatedRuns({
    agents,
    items: run.store.items(),
    name: run.name,
    sid: run.sid,
    repo: startInput.repo ?? null,
    branch: startInput.branch ?? null,
    now: run.input.at ?? new Date(),
  });
}

/** The card's later review round the run is in, when the card (its branch, or the run's) has new commits on top of a push. */
function roundOfStart(
  run: Start,
  onCard: Item | undefined,
  branch: string | null,
): RoundBase | null {
  const onBranch = onCard?.branch ?? branch;
  if (!onCard || !onBranch) {
    return null;
  }
  const runs = runsOf(onCard, readAgents(run.home).agents);
  return roundBaseOf({ branch: onBranch, pr: onCard.pr }, runs, mainCheckout(run.input.cwd));
}

export async function startRun(
  home: string,
  input: RunStartInput,
  options: RunIo = {},
): Promise<StartedRun> {
  const run = beginStart(home, input, options.warn ?? (() => {}));
  const registry = runRegistry(home, options.mirror);
  // read before the sweep: it stamps a long-dead run's end at now, which would make the run look active just now
  const beforeSweep = registry.agents();
  registry.sweep({
    liveSids: await (options.liveSids ?? (() => trustedLiveSids(home)))(),
    lastWrite: await liveWrites(home, beforeSweep),
  });
  const onPr = await branchOfPr(run, options);
  const { branch, pr } = onPr;
  const stamp = onPr.stamp ?? stampOfBranch(run);
  warnTypedRepo(run);
  const startInput = startInputOf(run, { branch, pr });
  const plan = planCard(run, registry, startInput, branch);
  // looked up before the registry writes, so the run is not its own match; reported only once the start is accepted
  const related = relatedOf(run, beforeSweep, startInput, plan);
  const started = registryStart(run, registry, startInput, plan, branch);
  // the join's writes, now that the start is accepted: what the card lacked
  if (plan.join?.link) {
    run.store.link(plan.join.joined.card, { ...plan.join.link, by: run.name.slice(0, 40) });
  }
  const onCard = teachCard(run, started, stamp, { branch, repo: startInput.repo ?? null });
  if (stamp) {
    stampBacklogCard(run, stamp, started, onCard);
  }
  return {
    ...started,
    stamped: run.card && stamp ? stamp : null,
    joined: plan.join?.joined ?? run.joinedCard ?? null,
    related,
    newCardAllowed: !joinsByBranch(run),
    round: roundOfStart(run, onCard, branch),
  };
}
