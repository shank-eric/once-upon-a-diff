/**
 * What the board knows of an agent that is not on a card: the column of a finished one, its summary, and whether a finished
 * author's commit waits on your review. Decided only by the fields the agent registered (`once-upon agent start`: repo, branch,
 * card, and the branch and PR its finish event reports), never by its task, name or outcome. An agent whose run names a card
 * (`agent start --card`, ADR-25) is shown on that card (state/src/queues/backlog/phase.ts) and never reaches here.
 */
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import {
  isCritic,
  lastActivity,
  type LedgerAgent,
} from '@once-upon-a-diff/state/records/agents/ledger';
import { KEEP_MS as FINISH_KEPT_MS } from '@once-upon-a-diff/adapters/stores/finished-agents';
import { DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import type { WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import { shortSha, plural } from '@once-upon-a-diff/terms/text';

/**
 * A finished author's commit that waits on your review: whether its branch is on origin yet (the `why` says which), and
 * the branch and the worktree it is in (the card's Review and Build story).
 */
export interface PendingReview {
  pushed: boolean;
  branch: string;
  path: string;
}

/**
 * Whether a finished author's commit waits on your review: it is done (not stopped or failed), an author's, with a
 * commit, on a registered repo and a branch that is not a default branch, whose worktree's tip is that commit and which
 * the scanner says is neither merged nor superseded (`trees`), and GitHub said the branch has no PR (`branchPr` null).
 * Only what is already known counts: no worktree facts, a merge state or PR not known yet, is no (the agent keeps today's
 * column). A commit made in a main checkout with no linked worktree is never seen here, as the scanner lists linked
 * worktrees only. The tip must be the commit, so a later worktree on a reused branch name, or a later commit on the same
 * branch, is not this agent's to wait on. It waits at most a week after its last activity, the time a Finish is kept for
 * (finished-agents.ts), so a Finish on its card is never forgotten while the card could come back.
 */
export function pendingReview(
  agent: Pick<LedgerAgent, 'state' | 'ended' | 'started'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'repo' | 'branch' | 'lastEvent'>>,
  trees: WorktreeFacts[],
  branchPr: (repo: string, branch: string) => BranchPr | null | undefined,
  nowMs: number,
): PendingReview | null {
  const repo = agent.repo ?? null;
  const branch = agent.result?.branch ?? agent.branch ?? null;
  const commit = agent.result?.commit?.toLowerCase() ?? '';
  const since = lastActivity(agent);
  if (
    agent.state !== 'done' ||
    agent.kind !== 'author' ||
    commit.length < 7 ||
    !since ||
    nowMs - since.getTime() >= FINISH_KEPT_MS ||
    !repo ||
    !branch ||
    DEFAULT_BRANCHES.has(branch)
  ) {
    return null;
  }
  const tree = trees.find((one) => !!one.repo && sameRepo(one.repo, repo) && one.branch === branch);
  if (
    !tree ||
    !tree.head?.toLowerCase().startsWith(commit) ||
    tree.defaultBranch === branch ||
    tree.merged !== false ||
    tree.superseded !== false
  ) {
    return null;
  }
  return branchPr(repo, branch) === null
    ? { pushed: tree.unpushed === 0, branch, path: tree.path }
    : null;
}

/**
 * The column of a finished agent that is not inside a card. No text is read: not the outcome, not the task, only what it
 * registered. In order:
 *
 *   failed                                    Waiting: it needs a look (stages/agents.ts)
 *   a critic                                  Done: its findings are in the story and the review file
 *   registered, done, its card landed         Done: the card it registered (--card) landed during this run (landedFor),
 *                                             though its finish named no commit (a launcher closing it after the deploy)
 *   registered, done, pending review          Ready for your review: an author's commit on a branch with no PR that is
 *                                             not merged (pendingReview), with or without a card, story or critic
 *   registered, finished with a result        Done: a commit, PR, branch or card (given with --commit, --pr, --branch or
 *                                             --card, or recorded from the registered branch moving, registry.ts). A
 *                                             stopped run made nothing to point at, whatever it recorded
 *   registered, no result, kind research      Research: done or stopped, it asks nothing and lost nothing
 *   registered, done, no result, kind helper  Done: a deploy, plan check or lookup did its job and asks nothing (a standing
 *                                             helper has no card at all, stages/helpers.ts; a plain one does)
 *   registered, no result, kind author        Waiting: an author that made nothing is a miss to look at
 *   registered, no result, no kind            Waiting, as before kinds existed: not known to be research or a helper
 *   registered, stopped, any kind but research  Waiting: interrupted work, a decision
 */
export function finishedColumn(
  agent: Pick<LedgerAgent, 'name' | 'state'> & Partial<Pick<LedgerAgent, 'kind' | 'result'>>,
  landed = false,
  pending: PendingReview | null = null,
): 'done' | 'research' | 'waiting' | 'ready' {
  if (agent.state === 'failed') {
    return 'waiting';
  }
  if (isCritic(agent)) {
    return 'done';
  }
  // a landing is checked first: a landed card is done whatever its branch says
  if (agent.state === 'done' && landed && agent.kind !== 'research') {
    return 'done';
  }
  if (pending) {
    return 'ready';
  }
  if (agent.state !== 'stopped' && agent.result && Object.keys(agent.result).length > 0) {
    return 'done';
  }
  if (agent.kind === 'research') {
    return 'research';
  }
  // a helper (or an editor) that finished its job with nothing to point at is done; only an author's miss, a stopped run
  // and a failure are for you to look at
  return agent.state === 'done' && agent.kind && agent.kind !== 'author' ? 'done' : 'waiting';
}

/**
 * Whether an agent's registered card landed for this run: it has landed, is not dropped (a drop keeps the landing, and
 * dropped stays dropped), and landed at or after the run started (an earlier landing is an earlier run's).
 */
export function landedFor(
  agent: Pick<LedgerAgent, 'started'>,
  item: Pick<BacklogItem, 'state' | 'landed_at'> | undefined,
): boolean {
  if (!item?.landed_at || item.state === 'dropped' || !agent.started) {
    return false;
  }
  return Date.parse(item.landed_at) >= agent.started.getTime();
}

/**
 * A finished agent's own card in brief. `did` is its claimed card's title, else its task, and null when that is only the
 * agent's name (its card's title). `why` is the first that fits, from its fields only (no outcome text): failed, stopped,
 * a critic's findings, its card's landing for this run (landedFor; not for a research run), its result's commit (with ", not
 * pushed" or ", no PR" when it waits on your review: pendingReview), PR or branch, a research run, an author's miss, done.
 */
export function finishedSummary(
  agent: Pick<LedgerAgent, 'name' | 'state' | 'task' | 'started'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'findings'>>,
  item: Pick<BacklogItem, 'title' | 'state' | 'landed_at' | 'landed_sha'> | undefined,
  pending: PendingReview | null = null,
): { did: string | null; why: string } {
  const text = (item?.title || agent.task || '').trim();
  const landed = landedFor(agent, item) ? { sha: item?.landed_sha ?? null } : null;
  return { did: text && text !== agent.name ? text : null, why: whyDone(agent, landed, pending) };
}

function whyDone(
  agent: Pick<LedgerAgent, 'name' | 'state'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'findings'>>,
  landed: { sha: string | null } | null,
  pending: PendingReview | null,
): string {
  if (agent.state === 'failed' || agent.state === 'stopped') {
    return agent.state;
  }
  if (isCritic(agent)) {
    if (typeof agent.findings !== 'number') {
      return 'critic done';
    }
    return agent.findings === 0 ? 'critic clean' : plural(agent.findings, 'finding');
  }
  const result = agent.result ?? {};
  if (landed && agent.kind !== 'research') {
    return landed.sha ? `landed ${shortSha(landed.sha)}` : 'landed';
  }
  if (result.commit) {
    const committed = `committed ${shortSha(result.commit)}`;
    if (pending) {
      return `${committed}, ${pending.pushed ? 'no PR' : 'not pushed'}`;
    }
    return committed;
  }
  if (result.pr) {
    return `PR #${result.pr}`;
  }
  if (result.branch) {
    return `on ${result.branch}`;
  }
  if (agent.kind === 'research') {
    return 'research done';
  }
  return agent.kind === 'author' ? 'made nothing to point at' : 'done';
}
