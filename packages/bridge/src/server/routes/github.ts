/*
 * POST /api/github/refresh {repo, branch?, number?, reason}: the extension saw you act on GitHub (submit a review, open or merge a
 * PR, mark it ready, close it). What the bridge last read about that branch's PR and your open PRs is marked stale, and the
 * board builds again right now, which asks GitHub again, so the card moves in seconds and not at the 3 minute poll
 * (../../services/review/auto-review.ts refresh). The token only. Its fields come from github.com's page, so the body is
 * checked (parseBody) and nothing here reaches GitHub for a repo or branch the board doesn't already follow.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import type { GithubRefreshAnswer } from '@once-upon-a-diff/protocol/types';
import type { ApiRoute, App, Call } from '../types.ts';

/** How long the answer waits for GitHub's answers to land before it goes without them. */
const SETTLE_MS = 8000;
/** At most this many refreshes a minute (a loop in a page can't make the bridge ask GitHub without end). */
const PER_MINUTE = 20;
const calls = new WeakMap<App, number[]>();

/** Counts a refresh against the minute's cap: false when it is over. */
function allowed(app: App, now: number): boolean {
  const recent = (calls.get(app) ?? []).filter((when) => now - when < 60_000);
  if (recent.length >= PER_MINUTE) {
    calls.set(app, recent);
    return false;
  }
  calls.set(app, [...recent, now]);
  return true;
}

async function refresh({ app, body: raw, send }: Call) {
  const body = parseBody('githubRefresh', raw);
  if (!allowed(app, Date.now())) {
    throw new HttpError(429, 'too many refreshes: the poll will catch up', 'rate_limited');
  }
  const what = body.branch ?? `#${body.number}`;
  if (!app.autoReview.refresh({ repo: body.repo, branch: body.branch, number: body.number })) {
    return send(200, { ok: true, refreshed: false, settled: true } satisfies GithubRefreshAnswer);
  }
  app.log(`github refresh ${body.repo} ${what} (${body.reason})`);
  // a build now, not one already running (it started before the stale mark): its stages ask GitHub for what is stale
  await app.board.rebuild();
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    app.autoReview.idle().then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SETTLE_MS);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  // the build above read the old answers: the next one reads the new
  app.board.refresh();
  return send(200, { ok: true, refreshed: true, settled } satisfies GithubRefreshAnswer);
}

export const githubRoutes: ApiRoute[] = [{ route: ROUTES.githubRefresh, handle: refresh }];
