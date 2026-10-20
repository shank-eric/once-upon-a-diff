/**
 * Add a drafted comment to Eric's pending review on a PR, through GitHub's API.
 *
 * Eric approved this on 2026-10-20 as the one write to GitHub: a comment goes into
 * his *pending* review (visible only to him until he submits it). It never submits
 * a review, never posts a standalone comment, never approves, and never touches
 * Viewed. If he has no pending review yet, one is started without an event, which
 * GitHub keeps as PENDING.
 *
 * Runs `gh api graphql` as the logged-in gh user, with GITHUB_TOKEN removed from the
 * environment (the keychain login has repo scope; GITHUB_TOKEN here is a yarn-only token).
 */
import { execFile } from 'node:child_process';

const GH = () => process.env.DIFF_STORY_GH || 'gh';

function graphql(query, vars) {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return new Promise((resolve, reject) => {
    execFile(GH(), args, { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
      let out;
      try { out = JSON.parse(stdout); } catch { return reject(new Error('gh returned something that isn\'t JSON')); }
      if (out.errors && out.errors.length) return reject(new Error(out.errors.map(e => e.message).join('; ')));
      resolve(out.data);
    });
  });
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
  if (!owner || !name) throw Object.assign(new Error('the story has no repo'), { status: 400 });
  if (!draft.path || !(Number(draft.line) > 0)) {
    throw Object.assign(new Error('only line comments can go into a review; copy this one instead'), { status: 400 });
  }
  const body = String(draft.body || '').trim();
  if (!body) throw Object.assign(new Error('the draft is empty'), { status: 400 });

  const found = await graphql(FIND, { owner, name, number: Number(number) });
  const pr = found.repository && found.repository.pullRequest;
  if (!pr) throw Object.assign(new Error(`couldn't find ${repo}#${number}`), { status: 404 });
  const mine = (pr.reviews.nodes || []).find(r => r.author && r.author.login === found.viewer.login);
  let review = mine && mine.id;
  let started = false;
  if (!review) {
    const s = await graphql(START, { pr: pr.id });
    review = s.addPullRequestReview.pullRequestReview.id;
    started = true;
  }
  const side = draft.side === 'L' ? 'LEFT' : 'RIGHT';
  const t = await graphql(THREAD, { review, path: draft.path, line: Number(draft.line), side, body });
  const node = t.addPullRequestReviewThread.thread && t.addPullRequestReviewThread.thread.comments.nodes[0];
  return { review, started, url: node ? node.url : null };
}
