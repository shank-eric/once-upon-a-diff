/**
 * Asks GitHub about each PR story the inbox lists. A PR that has merged is dropped from the inbox (a merged.json in
 * the story's state folder, which prStories skips). So is a PR closed without merging whose head branch is gone
 * (`headRef` is null; for a fork PR that is the fork's branch). Closed with the branch still there stays. Otherwise a story is marked
 * reviewed in the inbox by itself, for one of two reasons the reviewer has already acted on GitHub:
 *
 *   review       the signed-in gh user submitted a review on the PR after the story was built (approved, changes
 *                requested, or commented with a body: a reply in a thread is stored as a COMMENTED review with no body,
 *                so an empty one doesn't count)
 *   all viewed   every file in the PR is marked Viewed on GitHub (what skills/once-upon/bin/viewed.sh reads)
 *
 * It is a read-only GraphQL query through gh (ghEnv drops GITHUB_TOKEN when config.json says so), asked at most once
 * per PR every CACHE_MS, in the background: the inbox list asks for a check and answers at once, and the mark shows
 * on a later poll. There is one check per PR, and its whole answer is kept for the window: the inbox and the board
 * both read it, and it is applied to every listed story for that PR. The same answer carries what the agent board shows
 * about a PR (PrInfo: approvals, merge state, checks, the latest comments by you and by others), and a second small
 * query finds the PR for a branch. The board asks for both in the background as well and reads whatever is kept. A
 * story whose reviewed.json exists (marked by hand, or unmarked by hand) is never auto-marked, so a
 * manual unmark sticks. The reason is kept in reviewed.json as `by`.
 */
import { runGh } from '../config/gh.ts';
import { runGitAsync } from '../../adapters/git.ts';
import { clearApproval, readApproval } from './approve.ts';
import {
  DEFAULT_BRANCHES,
  markStoryDone,
  markStoryReviewed,
  storyHasState,
  type LocalEntry,
} from './story-lists.ts';
import type { StoryStore } from '../stories/store.ts';
import type { InboxStory, PrInfo, ReviewedBy } from '@once-upon-a-diff/shared/types';

/** How long one PR's answer (including "nothing yet") is kept before asking GitHub again. */
export const CACHE_MS = 3 * 60 * 1000;

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
interface PrNode {
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
interface Page {
  data?: {
    viewer: { login: string };
    repository: { pullRequest: PrNode | null } | null;
  };
  errors?: { message: string }[];
}

const latest = (times: (string | undefined)[]): string | null =>
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

/**
 * What stands between a PR and its merge button, in one plain line. GraphQL's `mergeable` only says there are no
 * conflicts, so this reads `mergeStateStatus` (CLEAN: the button works; BLOCKED: required reviews or checks are
 * missing; BEHIND, UNSTABLE, DIRTY, DRAFT) and, for BLOCKED, says which of approvals, changes requested, checks or open
 * threads is the reason. null while GitHub is still working it out.
 */
export function mergeSummary(input: {
  status: string | null | undefined;
  approvals: number;
  required: number | null;
  review: PrInfo['review'];
  checks: PrInfo['checks'];
  unresolved: number;
}): PrInfo['merge'] {
  const { status, approvals, required, review, checks, unresolved } = input;
  switch (status) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { ready: true, text: 'ready to merge', tone: 'ok' };
    case 'UNSTABLE':
      return { ready: true, text: 'ready to merge (optional checks failing)', tone: 'ok' };
    case 'DRAFT':
      return { ready: false, text: 'draft', tone: 'warn' };
    case 'DIRTY':
      return { ready: false, text: 'conflicts', tone: 'bad' };
    case 'BEHIND':
      return { ready: false, text: 'behind base', tone: 'warn' };
    case 'BLOCKED': {
      const short = required !== null ? required - approvals : 0;
      let text = 'blocked';
      let tone: 'warn' | 'bad' = 'warn';
      if (short > 0) {
        text = `needs ${short} more ${short === 1 ? 'approval' : 'approvals'}`;
      } else if (review === 'changes_requested') {
        text = 'changes requested';
        tone = 'bad';
      } else if (checks === 'failure') {
        text = 'checks failing';
        tone = 'bad';
      } else if (checks === 'pending') {
        text = 'checks running';
      } else if (unresolved > 0) {
        text = 'open threads to resolve';
      } else if (review === 'review_required' || approvals === 0) {
        text = 'needs approval';
      }
      return { ready: false, text, tone };
    }
    default:
      return null;
  }
}

/**
 * The base branch's required approving reviews as its rulesets say (`gh api repos/<repo>/rules/branches/<base>`, up to
 * 100 rules, which is as many as a page holds), kept 30 minutes.
 */
const rulesKept = new Map<string, { at: number; required: number | null }>();
const RULES_MS = 30 * 60 * 1000;
async function rulesRequired(repo: string, base: string): Promise<number | null> {
  const key = `${repo.toLowerCase()}@${base}`;
  const kept = rulesKept.get(key);
  if (kept && Date.now() - kept.at < RULES_MS) {
    return kept.required;
  }
  let required: number | null = null;
  try {
    const rules: unknown = JSON.parse(
      await runGh(
        ['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=100`],
        { timeout: 20000 },
      ),
    );
    const counts = (Array.isArray(rules) ? rules : [])
      .filter((rule) => rule?.type === 'pull_request')
      .map((rule) => Number(rule.parameters?.required_approving_review_count))
      .filter((count) => Number.isFinite(count));
    required = counts.length ? Math.max(...counts) : null;
  } catch {
    // not readable with this login, or no rulesets: protection rules are all there is
    required = null;
  }
  rulesKept.set(key, { at: Date.now(), required });
  return required;
}

/** What the board shows about a PR, from the query's first page. `required` is the strictest of protection and the rulesets, which GitHub enforces together. */
function infoOf(
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
    url: pr.url || `https://github.com/${repo}/pull/${number}`,
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
}
/** `checkout` is the local checkout the branch is in, where a merged PR's head commit is looked for. */
export type BranchCheck = (
  repo: string,
  branch: string,
  checkout: string,
) => Promise<BranchPr | null>;

/** Open and merged PRs are asked for separately, so a long run of merged ones (up to 100 of each) can't push the open one out. */
const PR_FIELDS = 'nodes{number mergedAt headRefOid headRepository{nameWithOwner}}';
const BRANCH_QUERY = `query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    open:pullRequests(headRefName:$branch,first:100,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){${PR_FIELDS}}
    merged:pullRequests(headRefName:$branch,first:100,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){${PR_FIELDS}}}}`;

interface BranchNode {
  number: number;
  mergedAt: string | null;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
}

/** Whether a commit is the local branch's tip or behind it (false when the checkout doesn't have the commit). */
async function onBranch(checkout: string, branch: string, oid: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
    return false;
  }
  const { code } = await runGitAsync(
    checkout,
    ['merge-base', '--is-ancestor', oid, `refs/heads/${branch}`],
    { timeout: 10000 },
  );
  return code === 0;
}

/**
 * The real branch check: `gh api graphql`. Only PRs whose head is in this repo count (a fork's branch of the same name
 * is someone else's work). An open one wins. A merged one counts only when its head commit is the local branch's tip
 * or behind it, so a branch name reused after a merge doesn't pick up the old PR; the latest merged one is taken.
 */
export const ghBranchCheck: BranchCheck = async (repo, branch, checkout) => {
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
    if (await onBranch(checkout, branch, node.headRefOid)) {
      return { number: node.number, state: 'merged', merged_at: node.mergedAt };
    }
  }
  return null;
};

/**
 * Whether a commit is already in the checkout's default branch (origin's, as last fetched): the commit is the branch's tip
 * or behind it. False when the ref or the commit is missing (git answers 128), so a story is never done by a guess.
 */
export async function inDefaultBranch(
  checkout: string,
  oid: string,
  { rewrittenFrom = null }: { rewrittenFrom?: string | null } = {},
): Promise<boolean> {
  const named = await runGitAsync(
    checkout,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    {
      timeout: 10000,
    },
  );
  const refs =
    named.code === 0 && named.stdout.trim()
      ? [named.stdout.trim()]
      : ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of refs) {
    const { code } = await runGitAsync(checkout, ['merge-base', '--is-ancestor', oid, ref], {
      timeout: 10000,
    });
    if (code === 0) {
      return true;
    }
  }
  // Commits pushed straight to the default branch after a rebase or amend are not the story's commit any more: its head
  // is in no ref, its base is in the default branch, and the checkout has nothing unpushed. Such a story's work shipped
  // under other ids, so it is delivered. Only a story with no branch of its own (`rewrittenFrom` is its base) is asked.
  if (!rewrittenFrom) {
    return false;
  }
  for (const ref of refs) {
    const based = await runGitAsync(checkout, ['merge-base', '--is-ancestor', rewrittenFrom, ref], {
      timeout: 10000,
    });
    if (based.code !== 0) {
      continue;
    }
    const held = await runGitAsync(
      checkout,
      ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', oid],
      { timeout: 10000 },
    );
    const unpushed = await runGitAsync(checkout, ['rev-list', '--count', `${ref}..HEAD`], {
      timeout: 10000,
    });
    return (
      held.code === 0 &&
      !held.stdout.trim() &&
      unpushed.code === 0 &&
      unpushed.stdout.trim() === '0'
    );
  }
  return false;
}

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}@${branch}`;

export class AutoReview {
  /** One check per PR: when it was asked, what it found (null when GitHub couldn't say), and the stories it has been applied to. */
  private checked = new Map<
    string,
    { at: number; facts: Promise<PrFacts | null>; applied: Set<string> }
  >();
  private running = new Set<Promise<void>>();
  private known = new Map<string, PrInfo>();
  private branches = new Map<string, { at: number; pr: BranchPr | null | undefined }>();
  /** when each local story's head was last looked for in the default branch (story id and head commit) */
  private delivered = new Map<string, number>();
  private stories: StoryStore;
  private check: PrCheck;
  private checkBranch: BranchCheck;
  private checkRequested: RequestedCheck;
  private asked: { at: number; list: { repo: string; number: number }[] } | null = null;
  private cacheMs: number;

  constructor(
    stories: StoryStore,
    check: PrCheck,
    cacheMs = CACHE_MS,
    checkBranch: BranchCheck = ghBranchCheck,
    checkRequested: RequestedCheck = ghRequestedCheck,
  ) {
    this.stories = stories;
    this.check = check;
    this.checkBranch = checkBranch;
    this.checkRequested = checkRequested;
    this.cacheMs = cacheMs;
  }

  /** What GitHub last said about a PR, or null when it hasn't answered yet (or the check carries no detail). */
  info(repo: string, number: number): PrInfo | null {
    return this.known.get(keyOf(repo, number)) || null;
  }

  /** The PR GitHub last said a branch has: null when it has none, undefined when it hasn't answered yet. */
  branchPr(repo: string, branch: string): BranchPr | null | undefined {
    return this.branches.get(branchKey(repo, branch))?.pr;
  }

  /** The open PRs GitHub last said wait on your review or are yours ([] until it first answers). */
  requested(): { repo: string; number: number }[] {
    return this.asked?.list || [];
  }

  /** Asks GitHub which open PRs wait on your review or are yours, unless it was asked lately. Doesn't wait. */
  kickRequested(now = Date.now()): void {
    if (this.asked && now - this.asked.at < this.cacheMs) {
      return;
    }
    this.asked = { at: now, list: this.asked?.list || [] };
    const job = this.checkRequested()
      .then((list) => {
        this.asked = { at: now, list };
      })
      .catch(() => undefined)
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Asks GitHub which PR a branch has (and, for a merged one, whether `checkout`'s branch contains it), unless it was asked lately. Doesn't wait. */
  kickBranch(repo: string, branch: string, checkout: string, now = Date.now()): void {
    const key = branchKey(repo, branch);
    const last = this.branches.get(key);
    if (last && now - last.at < this.cacheMs) {
      return;
    }
    // the old answer stays until the new one arrives, and a failed ask keeps it
    this.branches.set(key, { at: now, pr: last?.pr });
    const job = this.checkBranch(repo, branch, checkout)
      .then((pr) => {
        this.branches.set(key, { at: now, pr });
      })
      .catch(() => undefined)
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** The PR's check for this window: asked now unless it was asked lately, and kept whole so every caller sees the same answer. */
  private ask(repo: string, number: number, now: number) {
    const key = keyOf(repo, number);
    const last = this.checked.get(key);
    if (last && now - last.at < this.cacheMs) {
      return last;
    }
    const job: Promise<PrFacts | null> = this.check(repo, number)
      .then((facts) => {
        if (facts.info) {
          this.known.set(key, facts.info);
        }
        return facts;
      })
      .catch(() => null);
    const entry = { at: now, facts: job, applied: new Set<string>() };
    this.checked.set(key, entry);
    this.track(job);
    return entry;
  }

  private track(job: Promise<unknown>): void {
    const tracked = job.then(
      () => undefined,
      () => undefined,
    );
    const done = tracked.finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /** Asks about a PR that has no story in the inbox (the board's), for its details only. Shares the check a story's PR already has. */
  kickInfo(repo: string, number: number, now = Date.now()): void {
    this.ask(repo, number, now);
  }

  /** Starts a check for each story's PR that wasn't asked about lately, and applies what it found to every listed story of that PR. Doesn't wait. */
  kick(list: InboxStory[], now = Date.now()): void {
    for (const story of list) {
      const entry = this.ask(story.repo, story.number, now);
      if (entry.applied.has(story.id)) {
        continue;
      }
      entry.applied.add(story.id);
      this.track(
        entry.facts.then((facts) => {
          if (!facts) {
            return;
          }
          if (facts.merged || facts.abandoned) {
            markStoryDone(
              this.stories,
              story.id,
              facts.merged ? 'merged' : 'closed, branch deleted',
              facts.info?.merged_at ?? null,
            );
            return;
          }
          const why = whyReviewed(facts, story.built_at);
          if (why && !storyHasState(this.stories, story.id)) {
            // a story marked or unmarked by hand, even while GitHub was answering, is left as it is
            markStoryReviewed(this.stories, story.id, true, why);
          }
        }),
      );
    }
  }

  /**
   * Marks the local stories done that are: the branch has a PR on GitHub, open or merged (`pr`), or the story's head is
   * already in the default branch (`delivered`). Asked a few minutes apart per story, never waits, and leaves a story
   * with a reviewed.json (marked or unmarked by hand) as it is. The default branch is the checkout's last fetch of
   * origin, which the bridge never refreshes, so `delivered` can lag a fetch. A squash merge shows as a merged PR.
   */
  kickLocal(list: LocalEntry[], now = Date.now()): void {
    for (const entry of list) {
      const { story } = entry;
      if (entry.approval) {
        this.checkApproval(entry, now);
      }
      // a story you marked or unmarked by hand is left alone, but an approved one still gets the delivered check: pushing
      // it (Push on its page) is what ships it, and its card should clear then
      if (entry.marked && !entry.approval) {
        continue;
      }
      const onFeature = story.repo && story.branch && !DEFAULT_BRANCHES.has(story.branch);
      if (!entry.marked && onFeature && entry.repo_path) {
        this.kickBranch(story.repo as string, story.branch as string, entry.repo_path, now);
        if (this.branchPr(story.repo as string, story.branch as string)) {
          this.markLocal(story.id, 'pr');
          continue;
        }
      }
      const head = entry.head_oid;
      if (
        !entry.repo_path ||
        !head ||
        head === entry.base_oid ||
        !/^[0-9a-f]{40,64}$/i.test(head)
      ) {
        continue;
      }
      const key = `${story.id}@${head}`;
      const last = this.delivered.get(key);
      if (last !== undefined && now - last < this.cacheMs) {
        continue;
      }
      this.delivered.set(key, now);
      const checkout = entry.repo_path;
      const base =
        entry.base_oid && /^[0-9a-f]{40,64}$/i.test(entry.base_oid) ? entry.base_oid : null;
      const job = inDefaultBranch(checkout, head, { rewrittenFrom: onFeature ? null : base })
        .then((yes) => {
          if (yes) {
            this.markDelivered(story.id, head);
          }
        })
        .finally(() => this.running.delete(job));
      this.running.add(job);
    }
  }

  /**
   * An approved story whose branch has moved on is not approved any more: a cached `git rev-parse` of the ref the story
   * follows, and when it names another commit, the approval (and the reviewed mark approving wrote) is cleared. A ref git
   * can't resolve (repo gone, branch deleted) leaves it alone.
   */
  private checkApproval(entry: LocalEntry, now: number): void {
    const { approval, repo_path: checkout, head_ref: ref } = entry;
    if (!approval || !checkout || !ref) {
      return;
    }
    const key = `approval:${entry.story.id}@${approval.head_oid}`;
    const last = this.delivered.get(key);
    if (last !== undefined && now - last < this.cacheMs) {
      return;
    }
    this.delivered.set(key, now);
    const job = runGitAsync(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      timeout: 10000,
    })
      .then(({ code, stdout }) => {
        const tip = stdout.trim();
        const current = readApproval(this.stories, entry.story.id);
        if (
          code === 0 &&
          tip &&
          current?.head_oid === approval.head_oid &&
          tip !== approval.head_oid
        ) {
          clearApproval(this.stories, entry.story.id);
        }
      })
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Forgets when a story's heads were last looked for in the default branch, so the next kickLocal looks again (after a push). */
  forget(id: string): void {
    for (const key of this.delivered.keys()) {
      if (key.startsWith(`${id}@`) || key.startsWith(`approval:${id}@`)) {
        this.delivered.delete(key);
      }
    }
  }

  /**
   * A local story whose head is in the default branch is done. One approved at that head has shipped, so its approval
   * ends too (approved.json cleared, which takes it out of Ready to ship) and its mark becomes `delivered`.
   */
  private markDelivered(id: string, head: string): void {
    const approval = readApproval(this.stories, id);
    if (approval && approval.head_oid === head) {
      this.stories.writeState(id, 'approved.json', null);
      markStoryReviewed(this.stories, id, true, 'delivered');
      return;
    }
    this.markLocal(id, 'delivered');
  }

  /** Writes a local story's done mark unless a hand mark or unmark got there first. */
  private markLocal(id: string, why: ReviewedBy): void {
    if (!storyHasState(this.stories, id)) {
      markStoryReviewed(this.stories, id, true, why);
    }
  }

  /** Resolves when every check started so far has finished (for tests). */
  async idle(): Promise<void> {
    while (this.running.size) {
      await Promise.all([...this.running]);
    }
  }
}

export type { ReviewedBy };
