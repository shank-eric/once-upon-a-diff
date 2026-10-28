/*
 * The review inbox: the page (public/inbox.ts) lists what waits for review and the extension and the CLI open it.
 *
 *   GET  /api/inbox            the built PR stories and local stories (review-inbox/stories.ts) and each repo's counts;
 *                              ?repo=owner/name filters
 *   POST /api/inbox/reviewed   {story, reviewed}: mark a PR story or a local story (true by default) or unmark it
 *   POST /api/inbox/open       {story}: a local story's page link, with the story's read-only key: it can't push
 *   GET  /api/inbox/link       the inbox page's link (?repo= filters it), for the extension and the CLI
 *
 * The link needs the bridge's token. The rest also take the inbox page's key (page-key.ts), which reaches
 * these routes and nothing else (`inboxKey`).
 */
import { HttpError } from '../request.ts';
import { REPO_RE } from '../../config/repos.ts';
import { publicOriginOf } from '../address.ts';
import {
  localEntries,
  localStories,
  localStory,
  markStoryReviewed,
  prStories,
  prStory,
} from '../../review-inbox/stories.ts';
import type { ApiRoute, Call } from '../../types.ts';

function list({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  // the repo menu counts what waits there
  const repos = new Map<string, { repo: string; count: number; unreviewed: number }>();
  const everything = prStories(app.stories);
  const localList = localEntries(app.stories);
  const locals = localList.map((entry) => entry.story);
  // GitHub is asked in the background, a few minutes apart per PR, so this poll answers at once
  app.autoReview.kick(everything);
  app.autoReview.kickLocal(localList);
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
  // local stories count under their repo, or their checkout's folder name when it has no GitHub repo
  for (const story of locals) {
    const name = story.repo || story.repo_name;
    const entry = repos.get(name.toLowerCase()) || { repo: name, count: 0, unreviewed: 0 };
    entry.count++;
    entry.unreviewed += story.reviewed_at ? 0 : 1;
    repos.set(name.toLowerCase(), entry);
  }
  return send(200, {
    repos: [...repos.values()],
    stories: repo ? prStories(app.stories, { repo }) : everything,
    local_stories: repo ? localStories(app.stories, { repo }) : locals,
  });
}

function reviewed({ app, body, send }: Call) {
  const id = String(body.story);
  if (!prStory(app.stories, id) && !localStory(app.stories, id)) {
    throw new HttpError(404, 'no PR or local story with that id');
  }
  markStoryReviewed(app.stories, id, body.reviewed !== false);
  return send(200, { story: prStory(app.stories, id) ?? localStory(app.stories, id) });
}

/**
 * Takes a listed local story and hands back the page's link, with the story's read-only key: it reads, asks and takes
 * notes, but can't push (links only step down in power, so the inbox never gets the key that can). Opening a story
 * from the board or `once-upon page` gives the full key.
 */
function open({ app, body, send }: Call) {
  const story = localStory(app.stories, String(body.story));
  if (!story) {
    throw new HttpError(404, 'no local story with that id');
  }
  return send(200, { story: story.id, url: app.links.story(story.id, true) });
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
  { path: '/api/inbox/open', method: 'POST', handle: open, inboxKey: true },
  { path: '/api/inbox/link', method: 'GET', handle: link },
];
