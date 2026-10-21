/**
 * Add a drafted comment to the reviewer's pending review on a PR, through GitHub's API.
 *
 * This is the one write to GitHub, and only on a click of Add to my review: a comment goes
 * into the reviewer's *pending* review (visible only to them until they submit it). It never
 * submits a review, never posts a standalone comment, never approves, and never touches
 * Viewed. If there's no pending review yet, one is started without an event, which
 * GitHub keeps as PENDING.
 *
 * Runs `gh api graphql` as the logged-in gh user (GITHUB_TOKEN is dropped first when
 * config.json sets gh_unset_github_token).
 */
import { runGh } from '../util/gh.mjs';

async function graphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  }
  const stdout = await runGh(args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error("gh returned something that isn't JSON");
  }
  if (out.errors && out.errors.length) {
    throw new Error(out.errors.map((e) => e.message).join('; '));
  }
  return out.data;
}

const FIND = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviews(states: PENDING, first: 20) { nodes { id author { login } } }
    }
  }
}`;
const START = `mutation($pr: ID!) {
  addPullRequestReview(input: { pullRequestId: $pr }) { pullRequestReview { id state } }
}`;
const THREAD = `mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: $side, body: $body }) {
    thread { id comments(first: 1) { nodes { url } } }
  }
}`;

/**
 * @param {string} repo   "owner/name"
 * @param {number} number PR number
 * @param {{path: string, line: number, side?: 'R'|'L', body: string}} draft
 * @returns {Promise<{review: string, started: boolean, url: string|null}>}
 */
export async function addToPendingReview(repo, number, draft) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) {
    throw Object.assign(new Error('the story has no repo'), { status: 400 });
  }
  if (!draft.path || !(Number(draft.line) > 0)) {
    throw Object.assign(
      new Error('only line comments can go into a review; copy this one instead'),
      { status: 400 },
    );
  }
  const body = String(draft.body || '').trim();
  if (!body) {
    throw Object.assign(new Error('the draft is empty'), { status: 400 });
  }

  const found = await graphql(FIND, { owner, name, number: Number(number) });
  const pr = found.repository && found.repository.pullRequest;
  if (!pr) {
    throw Object.assign(new Error(`couldn't find ${repo}#${number}`), { status: 404 });
  }
  const mine = (pr.reviews.nodes || []).find(
    (pending) => pending.author && pending.author.login === found.viewer.login,
  );
  let review = mine && mine.id;
  let started = false;
  if (!review) {
    const created = await graphql(START, { pr: pr.id });
    review = created.addPullRequestReview.pullRequestReview.id;
    started = true;
  }
  const side = draft.side === 'L' ? 'LEFT' : 'RIGHT';
  const added = await graphql(THREAD, {
    review,
    path: draft.path,
    line: Number(draft.line),
    side,
    body,
  });
  const node =
    added.addPullRequestReviewThread.thread &&
    added.addPullRequestReviewThread.thread.comments.nodes[0];
  return { review, started, url: node ? node.url : null };
}
