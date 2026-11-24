/*
 * A card's review round. Round 1 is the work up to its first push. After the push (a PR open, or the branch simply on origin) new
 * commits on the same branch are round 2 of the same card: the card is back on the Mac's side, and the critic, the story and the
 * review of that round cover `origin/<branch>..HEAD` only, never what was already pushed. The round's base is derived, never
 * stored: while the branch is ahead it is the local `origin/<branch>` ref (a push ends the round, and the next one starts at the
 * new tip). It is handed out as a sha, because a story told over the ref name would re-resolve it on every refresh.
 */
import { ago } from '@once-upon-a-diff/terms/time';
import { shortSha } from '@once-upon-a-diff/terms/text';
import { commitOf, commitTime, isAncestor } from '@once-upon-a-diff/adapters/git';
import { isWorkRun } from '@once-upon-a-diff/state/queues/backlog/phase';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';

/** The base of a round after the first: the pushed tip the new commits are on top of. */
export interface RoundBase {
  /** the sha of the local `origin/<branch>` ref */
  sha: string;
  branch: string;
  /** when that commit was made, for the editor to catch a stale ref (a push from another clone) at a glance */
  at: Date | null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A finished work run whose recorded commit is on origin: the card's earlier round was pushed. */
function pushedARound(runs: LedgerAgent[], repo: string, origin: string): boolean {
  return runs.some(
    (run) =>
      isWorkRun(run) &&
      run.state === 'done' &&
      SHA_RE.test(run.result?.commit ?? '') &&
      isAncestor(repo, run.result?.commit ?? '', origin),
  );
}

/**
 * Whether the card's earlier round was pushed: a card with a PR was (the PR is the evidence, whatever work runs it has, and
 * whether or not a recorded sha survived a rebase before the push); a card with no PR needs a finished work run whose recorded
 * commit is on origin.
 */
function earlierRoundShipped(
  item: Pick<BacklogItem, 'pr'>,
  runs: LedgerAgent[],
  repo: string,
  origin: string,
): boolean {
  return !!item.pr || pushedARound(runs, repo, origin);
}

/**
 * The base of the card's round 2 (or later), or null when the card is in its first round or git cannot say. A round after the
 * first is when `origin/<branch>` is behind the branch (an ancestor of it, and not its tip: an amend or a rebase after the push
 * is no round, and reads null), and the card's earlier work was pushed: the card has a PR, or (no PR) a finished work run of the card recorded a commit that
 * is on origin. `checkout` is any checkout of the repo:
 * refs/remotes are shared by every worktree.
 */
export function roundBaseOf(
  item: Pick<BacklogItem, 'branch' | 'pr'>,
  runs: LedgerAgent[],
  checkout: string,
): RoundBase | null {
  const { branch } = item;
  if (!branch) {
    return null;
  }
  const origin = commitOf(checkout, `refs/remotes/origin/${branch}`);
  const tip = commitOf(checkout, `refs/heads/${branch}`);
  if (!origin || !tip || origin === tip || !isAncestor(checkout, origin, tip)) {
    return null;
  }
  if (!earlierRoundShipped(item, runs, checkout, origin)) {
    return null;
  }
  return { sha: origin, branch, at: commitTime(checkout, origin) };
}

/**
 * The line that says a card is in a later round, for a dispatch or a start to print: the base, the commit's age (a stale ref,
 * from a push made in another clone, shows at a glance) and how to override it.
 */
export function roundNote(round: RoundBase, now = Date.now()): string {
  const age = round.at ? ` (${ago(round.at.toISOString(), now)})` : '';
  return `round 2: new commits on top of origin/${round.branch} = ${shortSha(round.sha)}${age}; the critic, the story and the review cover ${shortSha(round.sha)}..HEAD only (a story's --base is the sha; dispatch --base overrides)`;
}
