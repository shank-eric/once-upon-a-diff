/**
 * Asks GitHub about each PR story the inbox lists. A PR that has merged is dropped from the inbox (a merged.json in
 * the story's state folder, which prStories skips). So is a PR closed without merging whose head branch is gone
 * (`headRef` is null; for a fork PR that is the fork's branch). Closed with the branch still there stays. Otherwise a story is marked
 * reviewed in the inbox by itself, for one of two reasons the reviewer has already acted on GitHub:
 *
 *   review       the signed-in gh user has submitted a review on the PR (approved, changes requested or commented)
 *   all viewed   every file in the PR is marked Viewed on GitHub (what skills/once-upon/bin/viewed.sh reads)
 *
 * It is a read-only GraphQL query through gh (ghEnv drops GITHUB_TOKEN when config.json says so), asked at most once
 * per PR every CACHE_MS, in the background: the inbox list asks for a check and answers at once, and the mark shows
 * on a later poll. The same answer carries what the agent board shows about a PR (PrInfo: approvals, merge state, checks,
 * the latest comments by you and by others), kept per PR, and a second small query finds the PR for a branch. The board
 * asks for both in the background as well and reads whatever is kept. A story whose reviewed.json exists (marked by hand, or unmarked by hand) is never auto-marked, so a
 * manual unmark sticks. The reason is kept in reviewed.json as `by`.
 */
import { runGh } from '../util/gh.ts';
import { markStoryDone, markStoryReviewed, storyHasState } from './stories.ts';
import type { StoryStore } from '../stories/store.ts';
import type { InboxStory, PrInfo, ReviewedBy } from '@once-upon-a-diff/shared/types';

/** How long one PR's answer (including "nothing yet") is kept before asking GitHub again. */
export const CACHE_MS = 3 * 60 * 1000;

/** What GitHub says about a PR: whether it merged, and why it counts as reviewed (null when it doesn't yet). Rejects when GitHub can't be asked. */
export interface PrFacts {
  merged: boolean;
  /** closed without merging, and its head branch (in the fork, for a fork PR) is gone */
  abandoned?: boolean;
  why: 'review' | 'all viewed' | null;
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
    reviews(last:100,states:[APPROVED,CHANGES_REQUESTED,COMMENTED]){nodes{state submittedAt author{login __typename}}}
    reviewThreads(last:50){nodes{isResolved opener:comments(first:1){nodes{createdAt body author{login __typename}}} comments(last:5){nodes{createdAt body author{login __typename}}}}}
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
 * When someone else last asked for something on a PR: a standing CHANGES_REQUESTED review, or an unresolved review
 * thread whose last comment is by someone else (not a bot, and not an AI-review comment unless that comment opened the
 * thread). Issue comments and COMMENTED reviews don't count, because nothing is asked of you in them.
 */
function actionAt(pr: PrNode, viewer: string): string | null {
  const times: (string | undefined)[] = [];
  const standing = new Set(
    (pr.latestOpinionatedReviews?.nodes || [])
      .filter((review) => review.state === 'CHANGES_REQUESTED')
      .map((review) => review.author?.login.toLowerCase()),
  );
  for (const review of pr.reviews.nodes) {
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
    const last = thread.comments.nodes[thread.comments.nodes.length - 1];
    const opener = thread.opener?.nodes[0];
    if (
      thread.isResolved ||
      !last ||
      isBotLike(last.author) ||
      last.author?.login.toLowerCase() === viewer
    ) {
      continue;
    }
    const marked = (last.body || '').includes(AI_REVIEW_MARKER);
    if (!marked || (opener && opener.createdAt === last.createdAt)) {
      times.push(last.createdAt);
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

/** The base branch's required approving reviews as its rulesets say (`gh api repos/<repo>/rules/branches/<base>`), kept 30 minutes. */
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
      await runGh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}`], {
        timeout: 20000,
      }),
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

/** What the board shows about a PR, from the query's first page. `required` is from rulesets when protection says nothing. */
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
  const required =
    pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ??
    pr.baseRef?.refUpdateRule?.requiredApprovingReviewCount ??
    rulesetRequired;
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
      const base =
        pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ??
        pr.baseRef?.refUpdateRule?.requiredApprovingReviewCount;
      const fromRulesets =
        base == null && !pr.merged && pr.state === 'OPEN' && pr.baseRefName
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
    if (pr.reviews.nodes.some((review) => review.author?.login.toLowerCase() === login)) {
      return { merged: false, why: 'review', info };
    }
    total = pr.files.totalCount;
    viewed += pr.files.nodes.filter((file) => file.viewerViewedState === 'VIEWED').length;
    if (!pr.files.pageInfo.hasNextPage) {
      break;
    }
    after = pr.files.pageInfo.endCursor;
  }
  return { merged: false, why: total > 0 && viewed === total ? 'all viewed' : null, info };
};

/** Open PRs GitHub is waiting on your review for (`review-requested:@me`), by repo and number. */
export type RequestedCheck = () => Promise<{ repo: string; number: number }[]>;

const REQUESTED_QUERY = `query{search(query:"is:pr is:open review-requested:@me archived:false",type:ISSUE,first:30){nodes{... on PullRequest{number repository{nameWithOwner}}}}}`;

export const ghRequestedCheck: RequestedCheck = async () => {
  const out: {
    data?: { search: { nodes: { number?: number; repository?: { nameWithOwner: string } }[] } };
    errors?: { message: string }[];
  } = JSON.parse(
    await runGh(['api', 'graphql', '-f', `query=${REQUESTED_QUERY}`], { timeout: 30000 }),
  );
  if (out.errors?.length || !out.data) {
    throw new Error(out.errors?.map((e) => e.message).join('; ') || 'no answer');
  }
  return out.data.search.nodes.flatMap((node) =>
    node.number && node.repository
      ? [{ repo: node.repository.nameWithOwner, number: node.number }]
      : [],
  );
};

/** The PR GitHub has for a branch: an open one, else the latest merged one. */
export interface BranchPr {
  number: number;
  state: 'open' | 'merged';
  merged_at: string | null;
}
export type BranchCheck = (repo: string, branch: string) => Promise<BranchPr | null>;

const BRANCH_QUERY = `query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,first:5,states:[OPEN,MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number state mergedAt}}}}`;

/** The real branch check: `gh api graphql`. */
export const ghBranchCheck: BranchCheck = async (repo, branch) => {
  const [owner, name] = repo.split('/');
  const out: {
    data?: {
      repository: {
        pullRequests: { nodes: { number: number; state: string; mergedAt: string | null }[] };
      } | null;
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
  const nodes = out.data.repository.pullRequests.nodes;
  const found = nodes.find((node) => node.state === 'OPEN') || nodes[0];
  return found
    ? {
        number: found.number,
        state: found.state === 'OPEN' ? 'open' : 'merged',
        merged_at: found.mergedAt,
      }
    : null;
};

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}@${branch}`;

export class AutoReview {
  private checked = new Map<string, number>();
  private running = new Set<Promise<void>>();
  private known = new Map<string, PrInfo>();
  private branches = new Map<string, { at: number; pr: BranchPr | null | undefined }>();
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

  /** The PRs GitHub last said are waiting on your review ([] until it first answers). */
  requested(): { repo: string; number: number }[] {
    return this.asked?.list || [];
  }

  /** Asks GitHub which open PRs wait on your review, unless it was asked lately. Doesn't wait. */
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

  /** Asks GitHub which PR a branch has, unless it was asked lately. Doesn't wait. */
  kickBranch(repo: string, branch: string, now = Date.now()): void {
    const key = branchKey(repo, branch);
    const last = this.branches.get(key);
    if (last && now - last.at < this.cacheMs) {
      return;
    }
    // the old answer stays until the new one arrives, and a failed ask keeps it
    this.branches.set(key, { at: now, pr: last?.pr });
    const job = this.checkBranch(repo, branch)
      .then((pr) => {
        this.branches.set(key, { at: now, pr });
      })
      .catch(() => undefined)
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Asks about a PR that has no story in the inbox (the board's), for its details only. */
  kickInfo(repo: string, number: number, now = Date.now()): void {
    const key = keyOf(repo, number);
    const last = this.checked.get(key);
    if (last !== undefined && now - last < this.cacheMs) {
      return;
    }
    this.checked.set(key, now);
    const job = this.check(repo, number)
      .then(({ info }) => {
        if (info) {
          this.known.set(key, info);
        }
      })
      .catch(() => undefined)
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Starts a check for each story that wasn't asked about lately. Doesn't wait. */
  kick(list: InboxStory[], now = Date.now()): void {
    for (const story of list) {
      const key = keyOf(story.repo, story.number);
      const last = this.checked.get(key);
      if (last !== undefined && now - last < this.cacheMs) {
        continue;
      }
      this.checked.set(key, now);
      const job = this.check(story.repo, story.number)
        .then(({ merged, abandoned, why, info }) => {
          if (info) {
            this.known.set(key, info);
          }
          if (merged || abandoned) {
            markStoryDone(
              this.stories,
              story.id,
              merged ? 'merged' : 'closed, branch deleted',
              info?.merged_at ?? null,
            );
          } else if (why && !storyHasState(this.stories, story.id)) {
            // a story marked or unmarked by hand, even while GitHub was answering, is left as it is
            markStoryReviewed(this.stories, story.id, true, why);
          }
        })
        .catch(() => undefined)
        .finally(() => this.running.delete(job));
      this.running.add(job);
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
