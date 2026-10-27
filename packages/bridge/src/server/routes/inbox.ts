/*
 * The review inbox's turns (../../capture/turns.ts): the bridge makes them from the capture hook's spool
 * (../../capture/spool.ts), the inbox page and the extension list and open them, and the reviewer marks them reviewed.
 *
 *   GET  /api/inbox            the newest turns, the built PR stories and local stories (review-inbox/stories.ts) and each repo's counts;
 *                              ?repo=owner/name filters, ?limit=N, ?unreviewed=1 leaves out the reviewed turns
 *   GET  /api/inbox/turn       ?id=: one turn and its diff
 *   POST /api/inbox/reviewed   {id, reviewed} or {story, reviewed}: mark a turn, a PR story or a local story (true by default) or unmark it
 *   POST /api/inbox/open       {id}: make the turn a local story and answer with its page link; {story}: a local story's page link
 *                              (both with the story's read-only key: it can't push)
 *   GET  /api/inbox/link       the inbox page's link (?repo= filters it), for the extension and the CLI
 *
 * The link needs the bridge's token. The rest also take the inbox page's key (page-key.ts), which reaches
 * these routes and nothing else (`inboxKey`).
 */
import { HttpError, toInt } from '../request.ts';
import { REPO_RE } from '../../config/repos.ts';
import { publicOriginOf } from '../address.ts';
import { storyIdOf, TURN_ID_RE } from '../../capture/turns.ts';
import {
  localStories,
  localStory,
  markStoryReviewed,
  prStories,
  prStory,
} from '../../review-inbox/stories.ts';
import type { ApiRoute, Call } from '../../types.ts';

const MAX_LIMIT = 500;

/** The turn the call names, or a 404. */
function turnOf({ app }: Call, id: unknown) {
  const kept = TURN_ID_RE.test(String(id)) ? app.turns.read(String(id)) : null;
  if (!kept) {
    throw new HttpError(404, 'no turn with that id');
  }
  return kept;
}

function list({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  const limit = toInt(url.searchParams.get('limit'));
  const turns = app.turns.list({
    repo: repo || null,
    limit: limit && limit > 0 ? Math.min(limit, MAX_LIMIT) : undefined,
    unreviewed: url.searchParams.get('unreviewed') === '1',
  });
  // the repo menu counts what waits there, turns and PR stories together
  const repos = new Map(turns.repos.map((entry) => [entry.repo.toLowerCase(), entry]));
  const everything = prStories(app.stories);
  const locals = localStories(app.stories);
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
  // local stories count under their repo, or their checkout's folder name when it has no GitHub repo
  for (const story of locals) {
    const name = story.repo || story.repo_name;
    const entry = repos.get(name.toLowerCase()) || { repo: name, count: 0, unreviewed: 0 };
    entry.count++;
    entry.unreviewed += story.reviewed_at ? 0 : 1;
    repos.set(name.toLowerCase(), entry);
  }
  return send(200, {
    ...turns,
    repos: [...repos.values()],
    stories: repo ? prStories(app.stories, { repo }) : everything,
    local_stories: repo ? localStories(app.stories, { repo }) : locals,
  });
}

const read = (call: Call) => call.send(200, turnOf(call, call.url.searchParams.get('id')));

function reviewed(call: Call) {
  const { app, body, send } = call;
  if (body.story !== undefined) {
    const id = String(body.story);
    if (!prStory(app.stories, id) && !localStory(app.stories, id)) {
      throw new HttpError(404, 'no PR or local story with that id');
    }
    markStoryReviewed(app.stories, id, body.reviewed !== false);
    return send(200, { story: prStory(app.stories, id) ?? localStory(app.stories, id) });
  }
  turnOf(call, body.id);
  const turn = app.turns.markReviewed(String(body.id), body.reviewed !== false);
  return send(200, { turn });
}

/**
 * Makes the turn a local story (or takes a listed local story as it is) and hands back the page's link, with the
 * story's read-only key: it reads, asks and takes notes, but can't push (links only step down in power, so the inbox
 * never gets the key that can). Opening a story from the board or `once-upon page` gives the full key.
 */
function open(call: Call) {
  const { app, body, send } = call;
  if (body.story !== undefined) {
    const story = localStory(app.stories, String(body.story));
    if (!story) {
      throw new HttpError(404, 'no local story with that id');
    }
    return send(200, { story: story.id, url: app.links.story(story.id, true) });
  }
  turnOf(call, body.id);
  const story = app.turns.openStory(String(body.id)) as string;
  return send(200, { story, url: app.links.story(storyIdOf(String(body.id)), true) });
}

/** The inbox's link: on 127.0.0.1 for the extension's own check, or (`?public=1`) on the proxy's address when it reaches this machine. */
async function link({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  const origin = url.searchParams.get('public') ? await publicOriginOf(app.home) : undefined;
  return send(200, {
    url: app.links.inbox(repo && REPO_RE.test(repo) ? repo : null, null, origin),
  });
}

export const inboxRoutes: ApiRoute[] = [
  { path: '/api/inbox', method: 'GET', handle: list, inboxKey: true },
  { path: '/api/inbox/turn', method: 'GET', handle: read, inboxKey: true },
  { path: '/api/inbox/reviewed', method: 'POST', handle: reviewed, inboxKey: true },
  { path: '/api/inbox/open', method: 'POST', handle: open, inboxKey: true },
  { path: '/api/inbox/link', method: 'GET', handle: link },
];
