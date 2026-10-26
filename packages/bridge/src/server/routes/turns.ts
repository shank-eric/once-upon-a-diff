/*
 * The review inbox's turns (../../turns/turns.ts): the Stop hook adds them, the inbox page and the extension list
 * and open them, and the reviewer marks them reviewed.
 *
 *   POST /api/turns            add one: {repo_path, base_tree, head_tree, session, branch, at, prompt, summary}
 *   GET  /api/turns            the newest turns, the built PR stories (turns/stories.ts) and each repo's counts;
 *                              ?repo=owner/name filters, ?limit=N
 *   GET  /api/turns/read       ?id=: one turn and its diff
 *   POST /api/turns/reviewed   {id, reviewed} or {story, reviewed}: mark a turn or a PR story (true by default) or unmark it
 *   POST /api/turns/open       {id}: make the turn a local story and answer with its page link
 *   GET  /api/turns/link       the inbox page's link (?repo= filters it), for the extension and the CLI
 *
 * Adding and the link need the bridge's token. The rest also take the inbox page's key (page-key.ts), which reaches
 * these routes and nothing else (`inboxKey`).
 */
import { HttpError, toInt } from '../request.ts';
import { REPO_RE } from '../../config/repos.ts';
import { publicOriginOf } from '../address.ts';
import { storyIdOf, TURN_ID_RE } from '../../turns/turns.ts';
import { markStoryReviewed, prStories, prStory } from '../../turns/stories.ts';
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

async function add({ app, body, send }: Call) {
  const turn = await app.turns.add(body);
  app.statusCache = null;
  return send(200, turn ? { turn } : { turn: null, note: 'nothing changed' });
}

function list({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  const limit = toInt(url.searchParams.get('limit'));
  const turns = app.turns.list({
    repo: repo || null,
    limit: limit && limit > 0 ? Math.min(limit, MAX_LIMIT) : undefined,
  });
  // the repo menu counts what waits there, turns and PR stories together
  const repos = new Map(turns.repos.map((entry) => [entry.repo.toLowerCase(), entry]));
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
    ...turns,
    repos: [...repos.values()],
    stories: repo ? prStories(app.stories, { repo }) : everything,
  });
}

const read = (call: Call) => call.send(200, turnOf(call, call.url.searchParams.get('id')));

function reviewed(call: Call) {
  const { app, body, send } = call;
  if (body.story !== undefined) {
    const story = prStory(app.stories, String(body.story));
    if (!story) {
      throw new HttpError(404, 'no PR story with that id');
    }
    markStoryReviewed(app.stories, story.id, body.reviewed !== false);
    return send(200, { story: prStory(app.stories, story.id) });
  }
  turnOf(call, body.id);
  const turn = app.turns.markReviewed(String(body.id), body.reviewed !== false);
  return send(200, { turn });
}

/** Makes the turn a local story and hands back the page's link, with the key for that story only. */
function open(call: Call) {
  const { app, body, send } = call;
  turnOf(call, body.id);
  const story = app.turns.openStory(String(body.id)) as string;
  return send(200, { story, url: app.links.story(storyIdOf(String(body.id))) });
}

/** The inbox's link: on 127.0.0.1 for the extension's own check, or (`?public=1`) on the proxy's address when it reaches this machine. */
async function link({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  const origin = url.searchParams.get('public') ? await publicOriginOf(app.home) : undefined;
  return send(200, {
    url: app.links.inbox(repo && REPO_RE.test(repo) ? repo : null, null, origin),
  });
}

export const turnRoutes: ApiRoute[] = [
  { path: '/api/turns', method: 'POST', handle: add },
  { path: '/api/turns', method: 'GET', handle: list, inboxKey: true },
  { path: '/api/turns/read', method: 'GET', handle: read, inboxKey: true },
  { path: '/api/turns/reviewed', method: 'POST', handle: reviewed, inboxKey: true },
  { path: '/api/turns/open', method: 'POST', handle: open, inboxKey: true },
  { path: '/api/turns/link', method: 'GET', handle: link },
];
