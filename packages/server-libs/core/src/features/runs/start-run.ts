/*
 * Starts a run on a card, in one place (ADR-25). The CLI's `agent start` parses its flags into a RunStartInput and calls this;
 * a later dispatch can call it with no CLI types. It owns everything that decides whether a start is allowed and what it is
 * stamped with: the role table, the flags a card refuses, the PR's head branch, the card's stamp, and the typed-repo warning.
 *
 * Write order: the run first, then the card. The registry refuses a start before it writes, so a refused start leaves the
 * card as it was. The two files have two locks and no lock spans both: if the stamp fails after the run is written, the
 * error says so and names `once-upon backlog branch`, which is idempotent and repairs it.
 */
import { repoOfCheckout, typedRepoNote } from '@once-upon-a-diff/foundation/repos';
import { prHeadBranch } from '@once-upon-a-diff/foundation/gh';
import { canonicalKind } from '@once-upon-a-diff/state/records/agents/events';
import type { AgentKind } from '@once-upon-a-diff/state/records/agents/agent-types';
import {
  flagsBesideCard,
  flagsBesideCardError,
  type AgentRegistry,
} from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { roleKind } from './roles.ts';
import { runRegistry, type Mirror } from './registry.ts';

/** What a start is asked for, as typed: strings that are empty count as absent. */
export interface RunStartInput {
  name: string;
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
}

export interface StartedRun {
  id: string;
  run: string;
  card: string | null;
  /** the branch (and repo) the card was stamped with, when it had none */
  stamped: { branch: string; repo: string | null } | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export async function startRun(
  home: string,
  input: RunStartInput,
  options: RunIo = {},
): Promise<StartedRun> {
  const warn = options.warn ?? (() => {});
  const name = input.name;
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
  registry.sweep();
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
      cardRepos: store.items().map((item) => item.repo),
      origin: repoOfCheckout(input.cwd),
    });
    if (note) {
      warn(`once-upon: ${note}`);
    }
  }
  const started = registry.start(
    {
      name,
      sid: text(input.sid) ?? input.session?.slice(0, 8) ?? '',
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
    },
    warn,
  );
  if (card && stamp) {
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
