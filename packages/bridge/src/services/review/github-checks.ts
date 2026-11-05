/**
 * The read-only GraphQL checks through gh: a PR's facts (ghPrCheck), the open PRs waiting on you or yours
 * (ghRequestedCheck), and the PR a branch has (ghBranchCheck).
 */
import { FULL_SHA_RE } from '@once-upon-a-diff/protocol/domain/patterns';
import { runGh } from '../config/gh.ts';
import { isAncestorAsync } from '../../adapters/git.ts';
import { rulesRequired } from './merge-rules.ts';
import { infoOf, latest, type PrNode } from './pr-info.ts';
import type { PrInfo } from '@once-upon-a-diff/protocol/types';

/**
 * What GitHub says about a PR: whether it merged, and why it counts as reviewed (null when it doesn't yet). Rejects when
 * GitHub can't be asked. `why` is the answer for a story built before your review; a story is judged on its own build
 * time from `reviewed_at` and `viewed`, when the check says them (a check that doesn't is read through `why`).
 */
export interface PrFacts {
  merged: boolean;
  /** closed without merging, and its head branch (in the fork, for a fork PR) is gone */
  abandoned?: boolean;
  why: 'review' | 'all viewed' | null;
  /** when you last submitted a review that counts (not a COMMENTED one with an empty body), null when you have not */
  reviewed_at?: string | null;
  /** every file in the PR is marked Viewed */
  viewed?: boolean;
  /** what the board shows; a check that doesn't say leaves it out */
  info?: PrInfo;
}
export type PrCheck = (repo: string, number: number) => Promise<PrFacts>;

const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){
  viewer{login}
  repository(owner:$owner,name:$name){pullRequest(number:$pr){
    number url title author{login} merged mergedAt state isDraft headRefName headRef{id} mergeStateStatus reviewDecision baseRefName
    baseRef{branchProtectionRule{requiredApprovingReviewCount} refUpdateRule{requiredApprovingReviewCount}}
    reviewRequests(first:30){nodes{requestedReviewer{... on User{login}}}}
    latestOpinionatedReviews(first:50){nodes{state author{login}}}
    reviews(last:100,states:[APPROVED,CHANGES_REQUESTED,COMMENTED]){nodes{state body submittedAt author{login __typename}}}
    reviewThreads(last:50){nodes{isResolved opener:comments(first:1){nodes{createdAt body author{login __typename}}} comments(last:30){nodes{createdAt body author{login __typename}}}}}
    comments(last:30){nodes{createdAt author{login __typename}}}
    commits(last:1){nodes{commit{committedDate author{user{login}} statusCheckRollup{state}}}}
    files(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{viewerViewedState}}}}}`;

interface Page {
  data?: {
    viewer: { login: string };
    repository: { pullRequest: PrNode | null } | null;
  };
  errors?: { message: string }[];
}

/** The real check: `gh api graphql`, as the signed-in gh user. */
export const ghPrCheck: PrCheck = async (repo, number) => {
  const [owner, name] = repo.split('/');
  let after: string | null = null;
  let viewed = 0;
  let total = 0;
  let info: PrInfo | undefined;
  let reviewedAt: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
    ];
    args.push('-F', `pr=${number}`);
    if (after) {
      args.push('-f', `after=${after}`);
    }
    const out: Page = JSON.parse(await runGh(args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    const pr = out.data?.repository?.pullRequest;
    if (out.errors?.length || !out.data || !pr) {
      throw new Error(out.errors?.map((e) => e.message).join('; ') || 'no such PR');
    }
    const login = out.data.viewer.login.toLowerCase();
    if (!info) {
      const fromRulesets =
        !pr.merged && pr.state === 'OPEN' && pr.baseRefName
          ? await rulesRequired(repo, pr.baseRefName)
          : null;
      info = infoOf(pr, login, repo, number, fromRulesets);
    }
    if (pr.merged) {
      return { merged: true, why: null, info };
    }
    if (pr.state === 'CLOSED' && !pr.headRef) {
      return { merged: false, abandoned: true, why: null, info };
    }
    reviewedAt = reviewedAt ?? latestReviewBy(pr, login);
    total = pr.files.totalCount;
    viewed += pr.files.nodes.filter((file) => file.viewerViewedState === 'VIEWED').length;
    if (!pr.files.pageInfo.hasNextPage) {
      break;
    }
    after = pr.files.pageInfo.endCursor;
  }
  const allViewed = total > 0 && viewed === total;
  let why: PrFacts['why'] = null;
  if (reviewedAt) {
    why = 'review';
  } else if (allViewed) {
    why = 'all viewed';
  }
  return { merged: false, why, reviewed_at: reviewedAt ?? null, viewed: allViewed, info };
};

/** When the viewer last submitted a review that counts: any state but a COMMENTED one with no body (what a reply in a thread leaves). */
function latestReviewBy(pr: PrNode, viewer: string): string | null {
  return latest(
    pr.reviews.nodes
      .filter(
        (review) =>
          review.author?.login.toLowerCase() === viewer &&
          (review.state !== 'COMMENTED' || !!review.body?.trim()),
      )
      .map((review) => review.submittedAt),
  );
}

/** Why a story counts as reviewed by what the check found, judged on when the story was built. */
export function whyReviewed(facts: PrFacts, builtAt: string): PrFacts['why'] {
  if (facts.reviewed_at === undefined && facts.viewed === undefined) {
    return facts.why;
  }
  const built = Date.parse(builtAt);
  if (facts.reviewed_at && Date.parse(facts.reviewed_at) > built) {
    return 'review';
  }
  return facts.viewed ? 'all viewed' : null;
}

/**
 * The open PRs the board starts from with or without a story, by repo and number: the ones GitHub is waiting on your
 * review for, and the ones you opened (a PR of yours with no story and no session on its branch is still yours to
 * watch). Only review requests made of you by name count (`user-review-requested:@me`, where `review-requested:@me`
 * also takes the teams you are in), the same as PrInfo's `review_requested`, which reads the requested reviewer as a User.
 */
export type RequestedCheck = () => Promise<{ repo: string; number: number }[]>;

const SEARCH_FIELDS = 'nodes{... on PullRequest{number repository{nameWithOwner}}}';
const REQUESTED_QUERY = `query{
  requested:search(query:"is:pr is:open user-review-requested:@me archived:false",type:ISSUE,first:30){${SEARCH_FIELDS}}
  mine:search(query:"is:pr is:open author:@me archived:false",type:ISSUE,first:50){${SEARCH_FIELDS}}}`;

type SearchNode = { number?: number; repository?: { nameWithOwner: string } };

/** The PRs in both searches' answers, each once, review requests first. */
export function requestedOf(data: {
  requested?: { nodes: SearchNode[] };
  mine?: { nodes: SearchNode[] };
}): { repo: string; number: number }[] {
  const seen = new Set<string>();
  return [...(data.requested?.nodes ?? []), ...(data.mine?.nodes ?? [])].flatMap((node) => {
    if (!node.number || !node.repository) {
      return [];
    }
    const key = `${node.repository.nameWithOwner.toLowerCase()}#${node.number}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ repo: node.repository.nameWithOwner, number: node.number }];
  });
}

export const ghRequestedCheck: RequestedCheck = async () => {
  const out: {
    data?: { requested?: { nodes: SearchNode[] }; mine?: { nodes: SearchNode[] } };
    errors?: { message: string }[];
  } = JSON.parse(
    await runGh(['api', 'graphql', '-f', `query=${REQUESTED_QUERY}`], { timeout: 30000 }),
  );
  if (out.errors?.length || !out.data) {
    throw new Error(out.errors?.map((e) => e.message).join('; ') || 'no answer');
  }
  return requestedOf(out.data);
};

/** The PR GitHub has for a branch: an open one, else the latest merged one that the local branch contains. */
export interface BranchPr {
  number: number;
  state: 'open' | 'merged';
  merged_at: string | null;
  /** a merged PR's last commit on the branch: what a squash merge shipped, which no ancestor check can see */
  head_oid?: string;
  /**
   * The asked heads (a story's head, its approved head) that the merged PR contains. GitHub can add a commit after
   * approval (Update branch, an applied suggestion), so a squash merge's last commit is then none of the story's heads
   * while the approved one is still among the PR's commits.
   */
  shipped?: string[];
}
/**
 * `checkout` is the local checkout the branch is in, where a merged PR's head commit is looked for. `heads` are commits
 * the caller's stories are at (the head, the approved head): a merged PR whose last commit is one of them counts without
 * the local branch containing it, which a deleted branch (`gh pr merge --delete-branch`) can't.
 */
export type BranchCheck = (
  repo: string,
  branch: string,
  checkout: string,
  heads?: string[],
) => Promise<BranchPr | null>;

/** Open and merged PRs are asked for separately, so a long run of merged ones (up to 100 of each) can't push the open one out. */
const PR_FIELDS = 'number mergedAt headRefOid headRepository{nameWithOwner}';
/** a merged PR's last 20 commits are asked too, to find the story's head among them when GitHub added a later commit */
const MERGED_FIELDS = `${PR_FIELDS} commits(last:20){nodes{commit{oid}}}`;
const BRANCH_QUERY = `query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    open:pullRequests(headRefName:$branch,first:100,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}
    merged:pullRequests(headRefName:$branch,first:100,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${MERGED_FIELDS}}}}}`;

interface BranchNode {
  number: number;
  mergedAt: string | null;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  commits?: { nodes: { commit: { oid: string } }[] };
}

/** Whether a commit is the local branch's tip or behind it (false when the checkout doesn't have the commit). */
async function onBranch(checkout: string, branch: string, oid: string): Promise<boolean> {
  if (!FULL_SHA_RE.test(oid)) {
    return false;
  }
  return isAncestorAsync(checkout, oid, `refs/heads/${branch}`, 10000);
}

/**
 * The real branch check: `gh api graphql`. Only PRs whose head is in this repo count (a fork's branch of the same name
 * is someone else's work). An open one wins. A merged one counts only when its head commit is the local branch's tip
 * or behind it, or one of the caller's heads is among its last commits (GitHub added a commit after the approval), so a
 * branch name reused after a merge doesn't pick up the old PR; the latest merged one is taken.
 */
export const ghBranchCheck: BranchCheck = async (repo, branch, checkout, heads = []) => {
  const [owner, name] = repo.split('/');
  const out: {
    data?: {
      repository: { open: { nodes: BranchNode[] }; merged: { nodes: BranchNode[] } } | null;
    };
    errors?: { message: string }[];
  } = JSON.parse(
    await runGh(
      [
        'api',
        'graphql',
        '-f',
        `query=${BRANCH_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `branch=${branch}`,
      ],
      { timeout: 30000 },
    ),
  );
  if (out.errors?.length || !out.data?.repository) {
    throw new Error(out.errors?.map((e) => e.message).join('; ') || 'no such repo');
  }
  const ours = (node: BranchNode) =>
    node.headRepository?.nameWithOwner.toLowerCase() === repo.toLowerCase();
  const open = out.data.repository.open.nodes.find(ours);
  if (open) {
    return { number: open.number, state: 'open', merged_at: null };
  }
  const merged = out.data.repository.merged.nodes
    .filter(ours)
    .sort((first, second) => (second.mergedAt || '').localeCompare(first.mergedAt || ''));
  for (const node of merged) {
    const oids = new Set(node.commits?.nodes.map((commit) => commit.commit.oid));
    const shipped = heads.filter((head) => head === node.headRefOid || oids.has(head));
    if (shipped.length || (await onBranch(checkout, branch, node.headRefOid))) {
      return {
        number: node.number,
        state: 'merged',
        merged_at: node.mergedAt,
        head_oid: node.headRefOid,
        ...(shipped.length ? { shipped } : {}),
      };
    }
  }
  return null;
};
