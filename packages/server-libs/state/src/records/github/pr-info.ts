/**
 * What the board shows about a PR (PrInfo), read from the PR check's first page: approvals, merge state, checks, and when
 * you and others last acted on it.
 */
import { mergeSummary } from './merge-rules.ts';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import { prUrl } from '@once-upon-a-diff/terms/github-urls';

interface Who {
  login: string;
  __typename?: string;
}
interface Stamped {
  createdAt?: string;
  body?: string;
  submittedAt?: string;
  author: Who | null;
}
export interface PrNode {
  number?: number;
  url?: string;
  title?: string;
  author?: Who | null;
  merged: boolean;
  mergedAt?: string | null;
  state: string;
  isDraft?: boolean;
  headRefName?: string | null;
  headRef: { id: string } | null;
  mergeStateStatus?: string;
  baseRefName?: string | null;
  reviewDecision?: string | null;
  baseRef?: {
    branchProtectionRule: { requiredApprovingReviewCount: number | null } | null;
    refUpdateRule: { requiredApprovingReviewCount: number | null } | null;
  } | null;
  reviewRequests?: { nodes: { requestedReviewer: { login?: string } | null }[] };
  latestOpinionatedReviews?: { nodes: { state: string; author: Who | null }[] };
  reviews: { nodes: (Stamped & { state?: string })[] };
  reviewThreads?: {
    nodes: {
      isResolved: boolean;
      opener?: { nodes: Stamped[] };
      comments: { nodes: Stamped[] };
    }[];
  };
  comments?: { nodes: Stamped[] };
  commits?: {
    nodes: {
      commit: {
        committedDate: string;
        author: { user: { login: string } | null } | null;
        statusCheckRollup: { state: string } | null;
      };
    }[];
  };
  files: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { viewerViewedState: string }[];
  };
}

export const latest = (times: (string | undefined)[]): string | null =>
  times
    .filter((time): time is string => !!time)
    .sort()
    .pop() ?? null;

/** Accounts that are tools, not people: a `[bot]` login, GitHub's Bot type, and the usual CI and scanner accounts. */
const BOT_LOGIN =
  /\[bot\]$|^(snyk-io|cypress|github-actions.*|dependabot.*|renovate.*|codecov.*|sonarcloud.*)$/i;
const isBotLike = (author: Who | null) =>
  !author || author.__typename === 'Bot' || BOT_LOGIN.test(author.login);
/** The automated AI review posts under a person's account and leaves this marker in its comments. */
const AI_REVIEW_MARKER = 'claude-ai-review';

/**
 * When someone else last asked something of you on a PR, which the board compares with your own last activity.
 *
 * On your own PR anyone counts: a standing CHANGES_REQUESTED review, or an unresolved review thread whose latest
 * comment that counts is by someone else (bots don't count, and neither does an AI-review comment unless it opened the
 * thread). Issue comments and COMMENTED reviews don't count, because nothing is asked of you in them.
 *
 * On someone else's PR, where you are one reviewer among several, only an answer to you counts: the same kind of latest
 * comment, in an unresolved thread you started or commented in. A thread you aren't in is for the author and the others
 * in it, and so is another reviewer's CHANGES_REQUESTED. (A review GitHub asks of you again is the PR's
 * `review_requested`, which the board reads on its own.)
 */
function actionAt(pr: PrNode, viewer: string): string | null {
  const own = pr.author?.login.toLowerCase() === viewer;
  const times: (string | undefined)[] = [];
  const standing = new Set(
    (pr.latestOpinionatedReviews?.nodes || [])
      .filter((review) => review.state === 'CHANGES_REQUESTED')
      .map((review) => review.author?.login.toLowerCase()),
  );
  for (const review of own ? pr.reviews.nodes : []) {
    const login = review.author?.login.toLowerCase();
    if (
      review.state === 'CHANGES_REQUESTED' &&
      login &&
      login !== viewer &&
      standing.has(login) &&
      !isBotLike(review.author)
    ) {
      times.push(review.submittedAt);
    }
  }
  for (const thread of pr.reviewThreads?.nodes || []) {
    if (thread.isResolved) {
      continue;
    }
    const opener = thread.opener?.nodes[0];
    if (
      !own &&
      ![...(opener ? [opener] : []), ...thread.comments.nodes].some(
        (comment) => comment.author?.login.toLowerCase() === viewer,
      )
    ) {
      continue;
    }
    // the newest comment that counts decides: bots and AI-review replies (unless one opened the thread) are passed
    // over, so they can't hide a person's request, and if that comment is yours nothing is asked
    const deciding = [...thread.comments.nodes]
      .reverse()
      .find(
        (comment) =>
          !isBotLike(comment.author) &&
          (!(comment.body || '').includes(AI_REVIEW_MARKER) ||
            (opener && opener.createdAt === comment.createdAt)),
      );
    if (deciding && deciding.author?.login.toLowerCase() !== viewer) {
      times.push(deciding.createdAt);
    }
  }
  return latest(times);
}

/** What the board shows about a PR, from the query's first page. `required` is the strictest of protection and the rulesets, which GitHub enforces together. */
export function infoOf(
  pr: PrNode,
  viewer: string,
  repo: string,
  number: number,
  rulesetRequired: number | null,
): PrInfo {
  const stamped = [
    ...pr.reviews.nodes,
    ...(pr.reviewThreads?.nodes.flatMap((thread) => thread.comments.nodes) || []),
    ...(pr.comments?.nodes || []),
  ].map((item) => ({ at: item.submittedAt || item.createdAt, author: item.author }));
  const mine = (author: Who | null) => author?.login.toLowerCase() === viewer;
  const commit = pr.commits?.nodes[0]?.commit;
  const opinions = pr.latestOpinionatedReviews?.nodes || [];
  const approvals = opinions.filter((review) => review.state === 'APPROVED').length;
  let review: PrInfo['review'] = null;
  if (opinions.some((opinion) => opinion.state === 'CHANGES_REQUESTED')) {
    review = 'changes_requested';
  } else if (pr.reviewDecision === 'APPROVED') {
    review = 'approved';
  } else if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    review = 'review_required';
  } else if (approvals > 0) {
    review = 'approved';
  }
  const rollup = commit?.statusCheckRollup?.state;
  let checks: PrInfo['checks'] = null;
  if (rollup === 'SUCCESS') {
    checks = 'success';
  } else if (rollup === 'FAILURE' || rollup === 'ERROR') {
    checks = 'failure';
  } else if (rollup === 'PENDING' || rollup === 'EXPECTED') {
    checks = 'pending';
  }
  const counts = [
    pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount,
    pr.baseRef?.refUpdateRule?.requiredApprovingReviewCount,
    rulesetRequired,
  ].filter((count): count is number => typeof count === 'number');
  const required = counts.length ? Math.max(...counts) : null;
  const unresolved = pr.reviewThreads?.nodes.filter((thread) => !thread.isResolved).length ?? 0;
  let state: PrInfo['state'] = 'open';
  if (pr.merged) {
    state = 'merged';
  } else if (pr.state === 'CLOSED') {
    state = 'closed';
  }
  return {
    number: pr.number ?? number,
    url: pr.url || prUrl(repo, number),
    title: pr.title || `${repo}#${number}`,
    state,
    draft: pr.isDraft === true,
    branch: pr.headRefName ?? null,
    author: pr.author?.login ?? null,
    mine: !!pr.author && mine(pr.author),
    review_requested:
      pr.reviewRequests?.nodes.some(
        (request) => request.requestedReviewer?.login?.toLowerCase() === viewer,
      ) ?? false,
    approvals,
    required,
    review,
    checks,
    merge:
      state === 'open'
        ? mergeSummary({
            status: pr.mergeStateStatus,
            approvals,
            required,
            review,
            checks,
            unresolved,
          })
        : null,
    merged_at: pr.mergedAt ?? null,
    unresolved,
    viewer_at: latest([
      ...stamped.filter((item) => mine(item.author)).map((item) => item.at),
      commit?.author?.user?.login.toLowerCase() === viewer ? commit.committedDate : undefined,
    ]),
    others_at: actionAt(pr, viewer),
  };
}
