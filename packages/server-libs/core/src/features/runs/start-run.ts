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
import { REPO_RE, repoOfCheckout, typedRepoNote } from '@once-upon-a-diff/foundation/repos';
import { BACKLOG_NOTE_MAX } from '@once-upon-a-diff/terms/text';
import { prHeadBranch } from '@once-upon-a-diff/foundation/gh';
import { canonicalKind, runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import type { AgentKind } from '@once-upon-a-diff/state/records/agents/agent-types';
import {
  flagsBesideCard,
  flagsBesideCardError,
  type AgentRegistry,
} from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { newImplicitCardId, newRunId } from '@once-upon-a-diff/foundation/ids';
import { ensureCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import { implicitTitle } from '@once-upon-a-diff/state/records/agents/implicit';
import { SESSION_RE } from '@once-upon-a-diff/terms/patterns';
import { isAbsolute } from 'node:path';
import { worktreeFacts } from '@once-upon-a-diff/adapters/git';
import { SELF_PREFIX, isSelfName } from '@once-upon-a-diff/terms/ids';
import { trustedLiveSids } from './live-sids.ts';
import { roleKind, selfProblem } from './roles.ts';
import { runRegistry, type Mirror } from './registry.ts';

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
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * The checkout a run works in, when it is a checkout of the branch the run is on: that is the card's worktree. A dispatched
 * author starts in the main checkout (it makes its worktree after), so a folder on another branch is not the work's.
 */
const worktreeOn = (cwd: string, branch: string | null): string | null =>
  branch && isAbsolute(cwd) && worktreeFacts(cwd)?.branch === branch ? cwd : null;

export async function startRun(
  home: string,
  input: RunStartInput,
  options: RunIo = {},
): Promise<StartedRun> {
  const warn = options.warn ?? (() => {});
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
  const name = input.self ? `${SELF_PREFIX}${newRunId().slice(2, 8)}` : input.name;
  // an editor is not an agent: it registers through `editor start`, where its slots are required
  if (canonicalKind(text(input.kind)) === 'editor' || input.slots !== undefined) {
    throw new Error('register an editor with: once-upon editor start --slots N');
  }
  const store = new BacklogStore(home);
  const lookup = cardLookup(store);
  const card = text(input.card);
  const role = text(input.role);
  const kind = roleKind(role, text(input.kind));
  const typedPr = text(input.pr);
  const typedBranch = text(input.branch);
  // a run on a card takes its repo and branch from the card, and what it does from --role: the typed ones are refused
  // (ADR-25, the flip), all named at once, before anything is written. An unknown card is the registry's to refuse
  if (card) {
    const item = lookup(card);
    const flags = [
      ...(input.kind != null ? ['--kind'] : []),
      ...flagsBesideCard(item ?? { repo: null, branch: null }, {
        repo: text(input.repo),
        branch: typedBranch,
        pr: typedPr,
        lane: text(input.lane),
      }),
    ];
    if (flags.length) {
      throw flagsBesideCardError(flags);
    }
  }
  if (role === 'storyteller' && !card && !typedPr && !typedBranch) {
    throw new Error('a storyteller needs --pr N, --branch NAME or --card ID');
  }
  // (a storyteller reads a PR or a branch, so either names its work with no card: the board joins it by that)
  if ((role === 'critic' || role === 'fixer') && !card) {
    throw new Error(`a ${role} works on a card: pass --card ID`);
  }
  // a story run with no role, PR, branch or card is a card of its own that no PR story can match (the board shows two
  // cards for one PR): the skill names story agents story-<id>, so the shape is caught here, by name
  if (!role && !card && !typedPr && !typedBranch && /^story-/.test(name)) {
    throw new Error('a story run needs --role storyteller with --pr N (or --branch NAME)');
  }
  const registry = runRegistry(home, options.mirror);
  registry.sweep({ liveSids: await (options.liveSids ?? (() => trustedLiveSids(home)))() });
  const sid = text(input.sid) ?? input.session?.slice(0, 8) ?? '';
  // a session's own author claims the card it starts on, as this run, since it has no launcher to do it: a card claimed by
  // another session is theirs, and the registry's one-author check says the rest. The claim comes before the start, so a
  // start the registry then refuses leaves a claim, which the next claim of the card replaces
  if (input.self && role === 'author' && card) {
    const item = store.listed().find((one) => one.id === card);
    if (item && item.state !== 'dropped' && !item.landed_at) {
      const held = item.claim;
      const own = held && (held.sid ?? held.session?.slice(0, 8)) === sid;
      // a claim a session's own run took (by 'self') whose run has ended, as one of a gone session does by the sweep above, is stale
      const stale =
        !!held &&
        isSelfName(held.agent) &&
        !registry.agents().some((one) => one.name === held.agent && runIsOpen(one));
      if (held && !own && !stale) {
        throw new Error(
          `${card} is claimed by ${held.agent}: a --self run does not take another session’s card`,
        );
      }
      // (an open author on the card is the registry's to refuse: it names the run, and the claim stays as it was)
      const busy = registry
        .agents()
        .some((one) => one.card === card && one.kind === 'author' && runIsOpen(one));
      if (!busy) {
        store.claim(card, { agent: name, sid, session: input.session, by: 'self' });
      }
    }
  }
  // --pr and no --branch: the PR's head branch is the run's branch, and a card that has none gets it too, so the board joins
  // the run, the card, the PR and the story by one branch. gh being down is no reason to refuse a start, except for a
  // storyteller: with no branch it has nothing to read
  let branch = typedBranch;
  let pr = typedPr;
  let stamp: { branch: string; repo: string | null } | null = null;
  if (typedPr && !typedBranch) {
    const item = card ? lookup(card) : null;
    const repo = (card ? item?.repo : null) ?? text(input.repo) ?? repoOfCheckout(input.cwd);
    if (!card || (item && !item.closed && !item.branch)) {
      try {
        if (!repo) {
          throw new Error('no repo to ask about (--repo owner/name)');
        }
        const head = await (options.prHead ?? prHeadBranch)(repo, Number(typedPr));
        if (!head) {
          throw new Error('it has no head branch');
        }
        branch = head;
        if (card) {
          // the registry cannot write the backlog: the run starts on the typed branch, and the card is stamped once the
          // run is accepted, so a refused start leaves the card as it was
          stamp = { branch: head, repo };
          pr = null;
        }
      } catch (err) {
        const why = `gh could not read #${typedPr}: ${(err as Error).message}`;
        if (role === 'storyteller' && !card) {
          throw new Error(`${why}; pass --branch NAME`);
        }
        warn(`once-upon: ${why}`);
      }
    }
  }
  // a typed --branch on an open card with no branch stamps the card too, the same way
  if (card && typedBranch && !stamp) {
    const item = lookup(card);
    if (item && !item.closed && !item.branch) {
      stamp = {
        branch: typedBranch,
        repo: item.repo ?? text(input.repo) ?? repoOfCheckout(input.cwd),
      };
    }
  }
  // a repo typed on a run that has no card (or whose card has no repo yet, so the typed one is kept) is checked; a run on a card
  // that has a repo takes the card's, and the registry already says so
  const typedRepo = text(input.repo);
  if (typedRepo && !(card && lookup(card)?.repo)) {
    const note = typedRepoNote(home, typedRepo, {
      cardRepos: store.listed().map((item) => item.repo),
      origin: repoOfCheckout(input.cwd),
    });
    if (note) {
      warn(`once-upon: ${note}`);
    }
  }
  const startInput = {
    name,
    sid,
    session: input.session,
    kind: (kind ?? undefined) as AgentKind | undefined,
    standing: input.standing,
    task: input.task,
    model: text(input.model),
    effort: text(input.effort),
    // the checkout the agent works in names the repo unless --repo says otherwise; a run on a card takes the card's
    repo: text(input.repo) ?? (card ? null : repoOfCheckout(input.cwd)),
    branch,
    pr,
    cwd: input.cwd,
    card,
    newCard: !!input.newCard,
    replaces: text(input.replaces),
    role: role as NonNullable<Parameters<AgentRegistry['start']>[0]['role']> | null,
    lane: text(input.lane),
    notes: text(input.notes),
    by: text(input.by),
  };
  // a run with no card makes its own (the registry mints its id): the card is stored first, with that id, so the run row and the
  // card agree. An author with no branch is refused by the registry, so nothing is stored for it
  let minted: string | null = null;
  if (registry.wouldMint(startInput) && !(kind === 'author' && !branch)) {
    minted = newImplicitCardId();
    const task = input.task.trim();
    const title = implicitTitle(task) || name;
    const repo = startInput.repo;
    ensureCard(store, {
      id: minted,
      source: 'agent',
      title,
      note: task && task !== title ? task.slice(0, BACKLOG_NOTE_MAX) : null,
      repo: repo && REPO_RE.test(repo) ? repo : null,
      branch,
      worktree: worktreeOn(input.cwd, branch),
      session: input.session && SESSION_RE.test(input.session) ? input.session : null,
      by: name.slice(0, 40),
    });
  }
  const started = registry.start({ ...startInput, mintedCard: minted }, warn);
  // what the run teaches its card: the checkout an author or fixer works in, and a branch or repo the card lacked (a card
  // an agent made is not started by it: only a backlog card is, `store.start`)
  const onCard = started.card ? store.items().find((one) => one.id === started.card) : undefined;
  if (onCard && !onCard.landed_at && onCard.state !== 'dropped' && onCard.source !== 'backlog') {
    store.link(onCard.id, {
      branch: stamp?.branch ?? (onCard.branch ? null : branch),
      repo: onCard.repo ? null : (stamp?.repo ?? startInput.repo),
      worktree:
        ['author', 'fixer'].includes(role ?? '') || (kind === 'author' && !role)
          ? worktreeOn(input.cwd, onCard.branch ?? stamp?.branch ?? branch)
          : null,
      by: text(input.by),
    });
  }
  if (card && stamp && (!onCard || onCard.source === 'backlog')) {
    try {
      store.start(card, { ...stamp, by: text(input.by) });
    } catch (err) {
      throw new Error(
        `run ${started.id} started, but ${card} could not be stamped with ${stamp.branch} (${(err as Error).message}): once-upon backlog branch ${card} ${stamp.branch} repairs it`,
      );
    }
  }
  return { ...started, stamped: card && stamp ? stamp : null };
}
