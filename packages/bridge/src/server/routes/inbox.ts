/*
 * The review inbox: the page (public/inbox.ts) lists what waits for review and the extension and the CLI open it.
 *
 *   GET  /api/inbox            the built PR stories (review-inbox/stories.ts) and each repo's counts;
 *                              ?repo=owner/name filters
 *   POST /api/inbox/reviewed   {story, reviewed}: mark a PR story (true by default) or unmark it
 *   GET  /api/inbox/link       the inbox page's link (?repo= filters it), for the extension and the CLI
 *
 * The link needs the bridge's token. The rest also take the inbox page's key (page-key.ts), which reaches
 * these routes and nothing else (`inboxKey`).
 */
import { HttpError } from '../request.ts';
import { REPO_RE } from '../../config/repos.ts';
import { publicOriginOf } from '../address.ts';
import { markStoryReviewed, prStories, prStory } from '../../review-inbox/stories.ts';
import type { ApiRoute, Call } from '../../types.ts';

function list({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  // the repo menu counts what waits there
  const repos = new Map<string, { repo: string; count: number; unreviewed: number }>();
  const everything = prStories(app.stories);
  // GitHub is asked in the background, a few minutes apart per PR, so this poll answers at once
  app.autoReview.kick(everything);
  for (const story of everything) {
    const entry = repos.get(story.repo.toLowerCase()) || {
      repo: story.repo,
      count: 0,
      unreviewed: 0,
    };
    entry.count++;
    entry.unreviewed += story.reviewed_at ? 0 : 1;
    repos.set(story.repo.toLowerCase(), entry);
  }
  return send(200, {
    repos: [...repos.values()],
    stories: repo ? prStories(app.stories, { repo }) : everything,
  });
}

function reviewed({ app, body, send }: Call) {
  const story = prStory(app.stories, String(body.story));
  if (!story) {
    throw new HttpError(404, 'no PR story with that id');
  }
  markStoryReviewed(app.stories, story.id, body.reviewed !== false);
  return send(200, { story: prStory(app.stories, story.id) });
}

/** The inbox's link: on 127.0.0.1 for the extension's own check, or (`?public=1`) on the proxy's address when it reaches this machine. */
async function link({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  const origin = url.searchParams.get('public') ? await publicOriginOf(app.home) : undefined;
  return send(200, {
    url: app.links.inbox(repo && REPO_RE.test(repo) ? repo : null, origin),
  });
}

export const inboxRoutes: ApiRoute[] = [
  { path: '/api/inbox', method: 'GET', handle: list, inboxKey: true },
  { path: '/api/inbox/reviewed', method: 'POST', handle: reviewed, inboxKey: true },
  { path: '/api/inbox/link', method: 'GET', handle: link },
];
