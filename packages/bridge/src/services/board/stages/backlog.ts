/**
 * The Backlog column: open items, and started ones marked onto the work cards they became. A started item is linked to
 * what is working it: worktrees on its branch, sessions, its ledger agent, and whether it merged (backlog-links.ts).
 */
import { checkoutFor, sameRepo, seenCheckouts } from '../../config/repos.ts';
import { assignLine, backlogCards, liveAssignment } from '../../backlog/backlog.ts';
import type { BacklogItem } from '../../backlog/backlog.ts';
import {
  agentLinks,
  owningAgent,
  startedLinks,
  worktreeOfAgent,
} from '../../backlog/backlog-links.ts';
import type { Worktree } from '../../backlog/backlog-links.ts';
import { checkoutsOf } from '../../worktrees/checkouts.ts';
import type { LedgerAgent } from '../../ledger/ledger.ts';
import { assignCandidates } from '../../sessions/listening.ts';
import type { ListeningInput } from '../../sessions/listening.ts';
import type { LiveSession } from '../../../adapters/claude-sessions/registry.ts';
import type {
  BoardBeat,
  BoardCard,
  BoardSession,
  BoardStartedLinks,
} from '@once-upon-a-diff/shared/types';
import { AGENT_OPEN } from './agents.ts';
import type { BuildContext, PinnedVoice, Work } from './types.ts';
import { dirOf } from './worktrees.ts';
import { branchOfWork } from './works.ts';

/** What a started item is linked against. */
export interface LinkFacts {
  items: BacklogItem[];
  live: LiveSession[];
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  works: Map<string, Work>;
  /** the newest local story's checkout for each repo and branch */
  localCheckouts: Map<string, { story: string; checkout: string }>;
  repoBySession: Map<string, string | null>;
  sessionViews: Map<string, BoardSession>;
}

/**
 * What is working each started item, and each open item a ledger agent names: its worktrees (looked up per repo, every checkout the board can learn of), the
 * sessions in them, its ledger agent, and whether its branch merged. Keyed by item id; an item nothing is found for has none.
 */
export async function readBacklogLinks(
  ctx: BuildContext,
  {
    items: backlogItems,
    live,
    agents,
    beats,
    works,
    localCheckouts,
    repoBySession,
    sessionViews,
  }: LinkFacts,
): Promise<Map<string, BoardStartedLinks>> {
  const { nowMs } = ctx;
  const startedItems = backlogItems.filter((item) => item.state === 'started' && item.branch);
  // an open item an agent owns (its task claims the id) is worked like a started one when the agent has a worktree
  const owned = backlogItems.flatMap((item) => {
    const agent = owningAgent(item, agents);
    return agent ? [{ item, agent }] : [];
  });
  const wanted = [...startedItems, ...owned.map((one) => one.item)];
  const treesByRepo = new Map<string, Worktree[]>();
  await Promise.all(
    [...new Set(wanted.flatMap((item) => (item.repo ? [item.repo.toLowerCase()] : [])))].map(
      async (key) => {
        const repo = wanted.find((item) => item.repo?.toLowerCase() === key)?.repo as string;
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
  // those owned items with a worktree are started, on its branch (nothing is written: it is worked out on read)
  const derived = new Set<string>();
  const worked: BacklogItem[] = [...startedItems];
  for (const { item, agent } of owned) {
    const tree = worktreeOfAgent(agent, treesByRepo.get((item.repo ?? '').toLowerCase()) ?? []);
    if (tree?.branch) {
      derived.add(item.id);
      worked.push({
        ...item,
        state: 'started',
        branch: tree.branch,
        started_by: agent.name,
        started_at: null,
      });
    }
  }
  const landedBranches = new Map<string, { at: number | null }>();
  await Promise.all(
    worked.map(async (item) => {
      const repoKey = (item.repo ?? '').toLowerCase();
      const landed = await ctx.lookups.mergedLocally(
        treesByRepo.get(repoKey) ?? [],
        item.branch as string,
        nowMs,
      );
      if (landed) {
        landedBranches.set(`${repoKey}@${item.branch}`, landed);
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
    beats,
    merged: (repo: string | null, branch: string) => {
      const landed = landedBranches.get(`${(repo ?? '').toLowerCase()}@${branch}`);
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
      const tree = treesByRepo
        .get((repo ?? '').toLowerCase())
        ?.find((one) => one.branch === branch);
      if (repo && tree) {
        ctx.review.kickBranch(repo, branch, tree.path);
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
      links.set(item.id, derived.has(item.id) ? { ...found, branch: item.branch } : found);
    }
  }
  // an open item an agent owns with no worktree (research, a plan) is linked by the agent alone
  for (const { item } of owned) {
    const found = derived.has(item.id) ? null : agentLinks(item, linkFacts);
    if (found) {
      links.set(item.id, found);
    }
  }
  return links;
}

/** What the open items' Assign candidates are worked out from. */
export interface AssignFacts {
  listening: ListeningInput;
  sessionViews: Map<string, BoardSession>;
  blankViews: { lane: string; view: BoardSession }[];
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
  { listening, sessionViews, blankViews, quietViews, pin, repoBySession }: AssignFacts,
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
  const added = backlogCards(backlogItems, cards, nowMs, cardless, links);
  const all = [...cards, ...added];

  // Assign: who may be handed each open item. Not the voice session or one that listens (`apart`, as for Start listening),
  // and not one already holding another item's live assignment
  for (const card of all) {
    const item = card.backlog && backlogItems.find((one) => one.id === card.backlog?.id);
    // (an item a ledger agent is working has its agent's chip, not an Assign)
    if (!card.backlog || !item || item.state !== 'open') {
      continue;
    }
    if (card.backlog.started || (card.backlog.agent && !card.backlog.agent.tried)) {
      continue;
    }
    const taken = new Set(
      backlogItems
        .filter((other) => other.id !== item.id)
        .map((other) => liveAssignment(other, nowMs)?.session)
        .filter((id): id is string => !!id),
    );
    // an item held by a session (assigned lately, not started) can only be sent to that one again, until it expires
    const holder = liveAssignment(item, nowMs)?.session;
    card.backlog.assign = {
      candidates: assignCandidates(
        item.repo,
        listening,
        new Set(taken),
        new Set(blankViews.map((one) => one.view.id)),
      ).filter((one) => !holder || one.id === holder),
      prompt: assignLine(item),
    };
    if (card.backlog.assigned) {
      const view = sessionViews.get(card.backlog.assigned.session);
      card.backlog.assigned.session_title = view?.title ?? null;
    }
  }
  return added;
}
