/**
 * What the board knows of an agent that is not on a card: the column of a finished one, its summary, and whether a finished
 * author's commit waits on your review. Decided only by the fields the agent registered (`once-upon agent start`: repo, branch,
 * card, and the branch and PR its finish event reports), never by its task, name or outcome. An agent whose run names a card
 * (`agent start --card`, ADR-25) is shown on that card (state/src/queues/backlog/phase.ts) and never reaches here.
 */
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import {
  isCritic,
  lastActivity,
  type LedgerAgent,
} from '@once-upon-a-diff/state/records/agents/ledger';
import { KEEP_MS as FINISH_KEPT_MS } from '@once-upon-a-diff/adapters/stores/finished-agents';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { findTree, type WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import { readyColumn, readyFactsOf } from '@once-upon-a-diff/state/queues/backlog/ready';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import { shortSha, plural } from '@once-upon-a-diff/terms/text';

/**
 * A finished author's commit that waits on you: whether its branch is on origin yet and whether it has a PR (the `why` says
 * which; `pr` is `open` or GitHub's `none`, never unknown), and the branch and the worktree it is in (the card's Review and
 * Build story). Its column is `pendingColumn`.
 */
export interface PendingReview {
  pushed: boolean;
  pr: 'open' | 'none';
  branch: string;
  path: string;
  /** the branch has moved past the commit (a new commit or an amend), and no other run's card carries the tip */
  working: boolean;
}

/**
 * The column of a pending commit (ready.ts): an open PR is PR open, pushed with no PR is Ready to ship, else Ready for your
 * review, or Working when its branch has moved past the commit.
 */
export function pendingColumn(pending: PendingReview): 'pr_open' | 'ship' | 'ready' | 'working' {
  return readyColumn({ pr: pending.pr, pushed: pending.pushed, working: pending.working });
}

/** What pendingReview asks of the board to tell a branch that moved past the author's commit from one that did not. */
export interface MovedLookup {
  /** the Lookups.movedPast answer for the worktree's tip (null: not known yet) */
  past: (tree: WorktreeFacts, commit: string, tip: string) => boolean | null;
  /** whether another run's own commit is that tip, so its card carries it (this one is then not the card to go Working) */
  carried: (repo: string, branch: string, tip: string) => boolean;
}

/**
 * Whether a finished author's commit waits on you: it is done (not stopped or failed), an author's, with a
 * commit, on a registered repo and a branch that is not a default branch, whose worktree's tip is that commit and which
 * the scanner says is neither merged nor superseded (`trees`), and GitHub has answered for the branch: it has no PR
 * (`branchPr` null) or an open one (`branchPr`, or the PR number the agent typed at finish once `prInfo` has it open: a number
 * GitHub has not answered for is ignored, and a closed or merged PR is no open PR). Only what is already known counts: no
 * worktree facts, a merge state or PR not known yet, is no (the agent keeps today's column). A commit made in a main checkout with no linked worktree is never seen here, as the scanner lists linked
 * worktrees only. The tip must be the commit, so a later worktree on a reused branch name, or a later commit on the same
 * branch, is not this agent's to wait on. It waits at most a week after its last activity, the time a Finish is kept for
 * (finished-agents.ts), so a Finish on its card is never forgotten while the card could come back.
 *
 * With `moved`, a branch whose tip is a later commit (or an amend) of the author's, and not another run's finished work, keeps
 * the card, as `working`: someone is still changing it. Without it, or while the lookup has no answer, a moved branch is not
 * this agent's to wait on, as before.
 */
export function pendingReview(
  agent: Pick<LedgerAgent, 'state' | 'ended' | 'started'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'repo' | 'branch' | 'lastEvent'>>,
  trees: WorktreeFacts[],
  branchPr: (repo: string, branch: string) => BranchPr | null | undefined,
  nowMs: number,
  prInfo: (repo: string, number: number) => PrInfo | null = () => null,
  moved?: MovedLookup,
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
    !isFeatureBranch(branch)
  ) {
    return null;
  }
  const tree = findTree(trees, repo, branch);
  const tip = tree?.head?.toLowerCase() ?? '';
  if (
    !tree ||
    !tip ||
    tree.defaultBranch === branch ||
    tree.merged !== false ||
    tree.superseded !== false
  ) {
    return null;
  }
  const working =
    !tip.startsWith(commit) &&
    !!moved &&
    !moved.carried(repo, branch, tip) &&
    moved.past(tree, commit, tip) === true;
  if (!tip.startsWith(commit) && !working) {
    return null;
  }
  const typed = agent.result?.pr;
  const facts = readyFactsOf({
    branchPr: branchPr(repo, branch),
    typedPr: typed ? prInfo(repo, typed) : null,
    unpushed: tree.unpushed,
  });
  return facts.pr === 'unknown'
    ? null
    : { pushed: facts.pushed === true, pr: facts.pr, branch, path: tree.path, working };
}

/** An author that finished done with no commit and changes left in its worktree (`agent finish` recorded it once). */
export function leftUncommitted(
  agent: Pick<LedgerAgent, 'state'> & Partial<Pick<LedgerAgent, 'kind' | 'result' | 'uncommitted'>>,
): boolean {
  return (
    agent.uncommitted === true &&
    agent.state === 'done' &&
    agent.kind === 'author' &&
    !agent.result?.commit
  );
}

/**
 * The column of a finished agent that is not inside a card. No text is read: not the outcome, not the task, only what it
 * registered. In order:
 *
 *   failed                                    Error (stages/agents.ts)
 *   a critic                                  Done: its findings are in the story and the review file
 *   registered, done, its card landed         Done: the card it registered (--card) landed during this run (landedFor),
 *                                             though its finish named no commit (a launcher closing it after the deploy)
 *   registered, done, pending review          An author's commit on a branch that is not merged (pendingReview), with or
 *                                             without a card, story or critic: with an open PR, PR open; pushed with no PR,
 *                                             Ready to ship; not pushed, Ready for your review, or Working when its
 *                                             branch moved past the commit (pendingColumn)
 *   registered, done, left uncommitted        Ready for your review: an author's worktree had changes and no commit when it
 *                                             finished (recorded once at the finish, never checked live)
 *   registered, finished with a result        Done: a commit, PR, branch or card (given with --commit, --pr, --branch or
 *                                             --card, or recorded from the registered branch moving, registry.ts). A
 *                                             stopped run made nothing to point at, whatever it recorded
 *   registered, no result, kind research      Research: done or stopped, it asks nothing and lost nothing
 *   registered, done, no result, kind helper  Done: a deploy, plan check or lookup did its job and asks nothing (a standing
 *                                             helper has no card at all, stages/helpers.ts; a plain one does)
 *   registered, no result, any other kind     Done: an author that made nothing, or a run of no known kind, asks nothing
 *   registered, stopped, any kind but research  Done: nothing to answer (Waiting is only an agent in state waiting)
 */
export function finishedColumn(
  agent: Pick<LedgerAgent, 'name' | 'state'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'uncommitted'>>,
  landed = false,
  pending: PendingReview | null = null,
): 'done' | 'research' | 'error' | 'ready' | 'working' | 'ship' | 'pr_open' {
  if (agent.state === 'failed') {
    return 'error';
  }
  if (isCritic(agent)) {
    return 'done';
  }
  // a landing is checked first: a landed card is done whatever its branch says
  if (agent.state === 'done' && landed && agent.kind !== 'research') {
    return 'done';
  }
  if (pending) {
    return pendingColumn(pending);
  }
  // an author that finished done with changes left in its worktree and no commit: no push state, so always for your review
  if (leftUncommitted(agent)) {
    return 'ready';
  }
  if (agent.state !== 'stopped' && agent.result && Object.keys(agent.result).length > 0) {
    return 'done';
  }
  if (agent.kind === 'research') {
    return 'research';
  }
  // nothing to point at and nothing to answer: Waiting is only an agent in state waiting, and a failure is Error
  return 'done';
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
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'findings' | 'uncommitted'>>,
  item: Pick<BacklogItem, 'title' | 'state' | 'landed_at' | 'landed_sha'> | undefined,
  pending: PendingReview | null = null,
): { did: string | null; why: string } {
  const text = (item?.title || agent.task || '').trim();
  const landed = landedFor(agent, item) ? { sha: item?.landed_sha ?? null } : null;
  return { did: text && text !== agent.name ? text : null, why: whyDone(agent, landed, pending) };
}

function whyDone(
  agent: Pick<LedgerAgent, 'name' | 'state'> &
    Partial<Pick<LedgerAgent, 'kind' | 'result' | 'findings' | 'uncommitted'>>,
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
  if (leftUncommitted(agent)) {
    return 'left uncommitted changes';
  }
  if (result.commit) {
    const committed = `committed ${shortSha(result.commit)}`;
    if (pending) {
      let state = pending.pushed ? 'no PR' : 'not pushed';
      if (pending.working) {
        state = 'branch moved on';
      }
      return `${committed}, ${pending.pr === 'open' ? 'PR open' : state}`;
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
