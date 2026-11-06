/**
 * The Backlog column: open items, and started ones marked onto the work cards they became. A started item is linked to
 * what is working it: worktrees on its branch, sessions, its registered agent, and whether it merged (backlog-links.ts).
 */
import { branchKey, repoKey } from '@once-upon-a-diff/terms/ids';
import { checkoutFor, sameRepo, seenCheckouts } from '@once-upon-a-diff/foundation/repos';
import {
  assignLine,
  backlogCards,
  cardOnBranch,
} from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import {
  claimedAgent,
  criticHold,
  sameAgentView,
} from '@once-upon-a-diff/state/queues/backlog/claims';
import {
  cardPhase,
  namedByRuns,
  runsOf,
  type CardPhase,
} from '@once-upon-a-diff/state/queues/backlog/phase';
import { agentLinks, startedLinks } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import type { Worktree } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import { checkoutsOf } from '@once-upon-a-diff/state/records/worktrees/checkouts';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import type {
  BoardAgent,
  BoardCard,
  BoardSession,
  BoardStartedLinks,
} from '@once-upon-a-diff/contracts/types';
import { AGENT_OPEN } from './agents.ts';
import type { BuildContext, PinnedVoice, Work } from './types.ts';
import { dirOf } from './worktrees.ts';
import { branchOfWork } from './works.ts';

/**
 * Puts each claimed agent on the work or session card of its started item's branch, before the columns are decided
 * (placeCards), so a running, gated or questioning author puts that card where its agent's state says. It changes the
 * cards given. The agent is held out of placeAgents, so this is the one place it appears. `views` is by item id.
 */
export function nestClaimedAgents(
  items: BacklogItem[],
  cards: BoardCard[],
  views: Map<string, BoardAgent[]>,
): void {
  for (const item of items) {
    const card = item.state === 'started' && item.branch ? cardOnBranch(item, cards) : null;
    for (const view of card ? (views.get(item.id) ?? []) : []) {
      if (card && !card.agents.some((one) => sameAgentView(one, view))) {
        card.agents.push(view);
      }
    }
  }
}

/** What a started item is linked against. */
export interface LinkFacts {
  items: BacklogItem[];
  live: LiveSession[];
  agents: LedgerAgent[];
  works: Map<string, Work>;
  /** the newest local story's checkout for each repo and branch */
  localCheckouts: Map<string, { story: string; checkout: string }>;
  repoBySession: Map<string, string | null>;
  sessionViews: Map<string, BoardSession>;
}

/**
 * What is working each started item, and each open item with a claimed agent: its worktrees (looked up per repo, every checkout the board can learn of), the
 * sessions in them, its agent, and whether its branch merged. Keyed by item id; an item nothing is found for has none.
 */
export async function readBacklogLinks(
  ctx: BuildContext,
  {
    items: backlogItems,
    live,
    agents,
    works,
    localCheckouts,
    repoBySession,
    sessionViews,
  }: LinkFacts,
): Promise<Map<string, BoardStartedLinks>> {
  const { nowMs } = ctx;
  const startedItems = backlogItems.filter((item) => item.state === 'started' && item.branch);
  const wanted = startedItems;
  const treesByRepo = new Map<string, Worktree[]>();
  await Promise.all(
    [...new Set(wanted.flatMap((item) => (item.repo ? [repoKey(item.repo)] : [])))].map(
      async (key) => {
        const repo = wanted.find((item) => item.repo && repoKey(item.repo) === key)?.repo as string;
        // every checkout of the repo the board can learn of (checkouts.ts); checkout_dirs only when none turns up
        const dirs = new Set<string>(
          await checkoutsOf(repo, {
            sessionDirs: live
              .filter((session) => sameRepo(repoBySession.get(session.session), repo))
              .map((session) => session.cwd),
            agentTasks: agents
              .filter(
                (agent) =>
                  AGENT_OPEN.includes(agent.state) ||
                  (agent.ended?.getTime() ?? 0) >= nowMs - ctx.settings.doneHours * 3600 * 1000,
              )
              .map((agent) => agent.task),
            seenDirs: [
              ...seenCheckouts(ctx.home),
              ...[...localCheckouts.values()].map((found) => found.checkout),
            ],
            dirOf,
            repoOf: (dir) => ctx.lookups.repoOf(dir),
            fallback: () => checkoutFor(ctx.home, repo),
          }),
        );
        const seenPaths = new Set<string>();
        const list: Worktree[] = [];
        for (const dir of await Promise.all(
          [...dirs].map((one) => ctx.lookups.worktreesOf(one, nowMs)),
        )) {
          for (const tree of dir) {
            if (!seenPaths.has(tree.path)) {
              seenPaths.add(tree.path);
              list.push(tree);
            }
          }
        }
        treesByRepo.set(key, list);
      },
    ),
  );
  const worked: BacklogItem[] = [...startedItems];
  const landedBranches = new Map<string, { at: number | null }>();
  await Promise.all(
    worked.map(async (item) => {
      const landed = await ctx.lookups.mergedLocally(
        treesByRepo.get(repoKey(item.repo)) ?? [],
        item.branch as string,
        nowMs,
      );
      if (landed) {
        landedBranches.set(branchKey(item.repo, item.branch as string), landed);
      }
    }),
  );
  const mergedWorks = [...works.values()].filter((work) => work.mergedAt);
  const linkFacts = {
    worktrees: treesByRepo,
    sessions: [...sessionViews.values()].map((view) => ({
      id: view.id,
      title: view.title,
      cwd: view.cwd,
      repo: repoBySession.get(view.id) ?? null,
      branch: view.branch,
    })),
    agents,
    merged: (repo: string | null, branch: string) => {
      const landed = landedBranches.get(branchKey(repo, branch));
      if (landed) {
        return landed;
      }
      const mergedWork = mergedWorks.find(
        (work) =>
          work.repo &&
          repo &&
          sameRepo(work.repo, repo) &&
          branchOfWork(ctx.review, work) === branch,
      );
      if (mergedWork) {
        const when = Date.parse(mergedWork.mergedAt ?? '');
        return { at: Number.isNaN(when) ? null : when };
      }
      const tree = treesByRepo.get(repoKey(repo))?.find((one) => one.branch === branch);
      if (repo && tree) {
        ctx.review.kickBranch(repo, branch, tree.path, nowMs);
      }
      const found = repo ? ctx.review.branchPr(repo, branch) : null;
      if (found?.state !== 'merged') {
        return null;
      }
      const when = Date.parse(found.merged_at ?? '');
      return { at: Number.isNaN(when) ? null : when };
    },
  };
  const links = new Map<string, BoardStartedLinks>();
  for (const item of worked) {
    const found = startedLinks(item, linkFacts);
    if (found) {
      links.set(item.id, found);
    }
  }
  // an open item with a claimed agent is linked by the agent alone (a branch comes with a `start`: `claim --branch`)
  for (const item of backlogItems) {
    const found = item.state === 'open' ? agentLinks(item, linkFacts) : null;
    if (found) {
      links.set(item.id, found);
    }
  }
  return links;
}

/** What the open items' cards are worked out from: the sessions' views (for the title of the one an item was sent to) and the sessions an item may stand in for. */
export interface AssignFacts {
  sessionViews: Map<string, BoardSession>;
  quietViews: BoardSession[];
  pin: PinnedVoice | null;
  repoBySession: Map<string, string | null>;
}

/**
 * The backlog's cards: an open item is a card in Backlog with who may be handed it (Assign), a started one is marked
 * onto the card of its branch (`from_backlog`, which changes the card given) or is a card of its own while it is worked
 * or done. Returns the new cards, to go after the others.
 */
export function addBacklogCards(
  ctx: BuildContext,
  cards: BoardCard[],
  backlogItems: BacklogItem[],
  links: Map<string, BoardStartedLinks>,
  { sessionViews, quietViews, pin, repoBySession }: AssignFacts,
  views: Map<string, BoardAgent[]> = new Map(),
  agents: LedgerAgent[] = [],
): BoardCard[] {
  const { nowMs } = ctx;
  const cardless = [
    ...quietViews.map((view) => ({
      repo: repoBySession.get(view.id) ?? null,
      branch: view.branch,
      label: view.title,
    })),
    ...(pin ? [{ repo: pin.repo, branch: pin.view.branch, label: 'Voice session' }] : []),
  ];
  // a finished card waits out its critic's run and its fix round before it can be Ready to ship
  const holds = new Map<string, BoardCard['column']>();
  // a card that runs name is read by those runs (cardPhase); one no run names, by its claim and criticHold (the old rules)
  const phases = new Map<string, CardPhase | null>();
  for (const item of backlogItems) {
    if (item.state !== 'dropped' && namedByRuns(item, agents)) {
      const phase = cardPhase(item, runsOf(item, agents), nowMs);
      if (phase !== undefined) {
        phases.set(item.id, phase);
      }
      continue;
    }
    const author = claimedAgent(item, agents);
    const hold = author ? criticHold(item, author, agents, nowMs) : null;
    if (hold) {
      holds.set(item.id, hold);
    }
  }
  const added = backlogCards(backlogItems, cards, nowMs, cardless, links, views, holds, phases);
  const all = [...cards, ...added];

  // Assign: sends the voice session "Start backlog card ...", so every open item the board is not already working has it
  for (const card of all) {
    const item = card.backlog && backlogItems.find((one) => one.id === card.backlog?.id);
    // (a claimed item has its agent's chip, not an Assign)
    if (!card.backlog || !item || item.state !== 'open') {
      continue;
    }
    if (card.backlog.started || (card.backlog.claim && !card.backlog.agent?.tried)) {
      continue;
    }
    // (a card whose runs are working it, an adopted implicit card with no branch yet, has nothing to assign either; one sent back to Backlog still does)
    const phase = phases.get(item.id);
    if (phase && phase.column !== 'backlog') {
      continue;
    }
    // (a someday card is out of the pick order: no Assign until it is back in the backlog)
    if (item.someday) {
      continue;
    }
    card.backlog.assign = { prompt: assignLine(item) };
    if (card.backlog.assigned) {
      const sent = card.backlog.assigned.session;
      const view = sessionViews.get(sent) ?? (pin?.view.id === sent ? pin.view : undefined);
      card.backlog.assigned.session_title = view?.title ?? null;
    }
  }
  return added;
}
