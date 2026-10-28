/*
 * The agent board (../../board/board.ts): the live Claude Code sessions and the ledger's background agents.
 *
 *   GET /api/board              the lanes and their cards
 *   GET /api/board/link         the board page's link. With the bridge's token (the extension, the CLI) it carries the board's
 *                               key. With the inbox page's key it has none (the board's cookie connects it, or its
 *                               not-connected page says how)
 *   POST /api/board/type        {kind: build|listen, session, repo?}: type Build story's or Start listening's line into the
 *                               session's iTerm tab, when the session is at its prompt
 *   POST /api/board/stop-listening  {repo}: end the repo's listener
 *   POST /api/board/focus       {session}: bring that session's iTerm tab to the front (the tab is found server-side)
 *   POST /api/board/open-story  {story}: a local story's page link (a card's Open story), with that story's full key
 *   POST /api/board/reviewed    {story, reviewed?}: mark a local story reviewed (a card's Mark reviewed), or unmark it with
 *                               reviewed: false. A local story only: PR stories are the inbox's
 *   POST /api/board/backlog     {title, note?, repo?}: add a backlog item (the Backlog column's Add)
 *   POST /api/board/backlog/move {id, before | edge}: reorder (before another item's id, or edge top or bottom)
 *   POST /api/board/backlog/drop {id}: drop one. Start is the CLI's (`once-upon backlog start`), not the page's
 *   GET /api/board/inbox-link   the review inbox page's link, ?repo= for a repo's PR stories, for a card's badge
 *
 * Links only step down in power. The board page's key reaches the board (it types into sessions) and the inbox's link,
 * which carries the inbox's key, a lesser one. The inbox page's key reaches the board's link without a key in it, so an
 * inbox key can never obtain the board's. Only the bridge's token is handed the board's key.
 */
import { REPO_RE } from '../../config/repos.ts';
import { readSettings } from '../../config/settings.ts';
import { publicOriginOf } from '../address.ts';
import { HttpError } from '../request.ts';
import { localStory, markStoryReviewed } from '../../review-inbox/stories.ts';
import type { MoveTo } from '../../board/backlog.ts';
import type { ApiRoute, Call } from '../../types.ts';

const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;

async function data({ app, send }: Call) {
  return send(200, await app.board.snapshot());
}

/** The address the page was opened on, when it is a name from allowed_hosts, so the other page opens there too (and has its own cookie). */
function originOf({ app, req }: Call): string | undefined {
  const host = String(req.headers.host || '').toLowerCase();
  return readSettings(app.home).allowedHosts.includes(host) ? `https://${host}` : undefined;
}

/**
 * The board page's link. A page asks on the address it is on (originOf); the extension, which calls the bridge on
 * 127.0.0.1, asks for `?public=1` and gets the proxy's address when that name reaches this machine. The inbox page's
 * key gets the address alone: the board's key is more than the inbox's, so it doesn't pass down. On an allowed host the
 * board's own cookie connects the page, and otherwise the board says to open it from `once-upon board` or the extension.
 */
async function boardLink(call: Call) {
  const origin = call.url.searchParams.get('public')
    ? await publicOriginOf(call.app.home)
    : originOf(call);
  if (call.pageScope === 'inbox') {
    return call.send(200, { url: call.app.links.boardAddress(origin) });
  }
  return call.send(200, { url: call.app.links.board(origin) });
}

function inboxLink(call: Call) {
  const { app, url, send } = call;
  const repo = url.searchParams.get('repo');
  return send(200, {
    url: app.links.inbox(repo && REPO_RE.test(repo) ? repo : null, originOf(call)),
  });
}

async function focus({ app, body, send }: Call) {
  const session = String(body.session || '');
  if (!SESSION_RE.test(session)) {
    throw new HttpError(400, 'a session id is needed');
  }
  await app.board.focus(session);
  return send(200, { ok: true });
}

/** POST {kind: 'build' | 'listen', session, repo?}: type Build story's or Start listening's line into the session's tab. */
async function type({ app, body, send }: Call) {
  const session = String(body.session || '');
  let kind: 'build' | 'listen' | null = null;
  if (body.kind === 'listen' || body.kind === 'build') {
    kind = body.kind;
  }
  if (!kind || !SESSION_RE.test(session)) {
    throw new HttpError(400, 'a kind (build or listen) and a session id are needed');
  }
  const typed = await app.board.type(kind, session, body.repo ? String(body.repo) : null);
  return send(200, { ok: true, typed });
}

/** POST {story}: the page link of a local story on a card, which has no URL of its own like a PR story's. */
function openStory({ app, body, send }: Call) {
  const story = localStory(app.stories, String(body.story || ''));
  if (!story) {
    throw new HttpError(404, 'no local story with that id');
  }
  return send(200, { url: app.links.story(story.id) });
}

/** An error from the backlog's checks (a bad repo, a missing title, an unknown item) is the caller's: 400. */
function asBadRequest<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

/** POST {story, reviewed?}: a local story marked reviewed by hand (or unmarked). A PR story's id is a 404 here. */
function reviewLocal({ app, body, send }: Call) {
  const id = String(body.story ?? '');
  if (!localStory(app.stories, id)) {
    throw new HttpError(404, 'no local story with that id');
  }
  markStoryReviewed(app.stories, id, body.reviewed !== false);
  return send(200, { ok: true });
}

/** POST {title, note?, repo?}: a new backlog item, by "board". */
function addBacklog({ app, body, send }: Call) {
  const item = asBadRequest(() =>
    app.board.addBacklog({
      title: String(body.title ?? ''),
      note: body.note ? String(body.note) : null,
      repo: body.repo ? String(body.repo) : null,
      by: 'board',
    }),
  );
  return send(200, { ok: true, id: item.id });
}

/** POST {id, before | edge}: put a backlog item before another, or at the top or bottom. */
function moveBacklog({ app, body, send }: Call) {
  const where: MoveTo = body.before
    ? { before: String(body.before) }
    : { edge: body.edge === 'top' ? 'top' : 'bottom' };
  if (!body.before && body.edge !== 'top' && body.edge !== 'bottom') {
    throw new HttpError(400, 'before (an item id) or edge (top or bottom) is needed');
  }
  asBadRequest(() => app.board.moveBacklog(String(body.id ?? ''), where, 'board'));
  return send(200, { ok: true });
}

/** POST {id}: drop a backlog item. The line stays in the file. */
function dropBacklog({ app, body, send }: Call) {
  asBadRequest(() => app.board.dropBacklog(String(body.id ?? ''), 'board'));
  return send(200, { ok: true });
}

/** POST {repo}: end the repo's listener (its `wait` returns "Stopped listening"). */
function stopListening({ app, body, send }: Call) {
  app.board.stopListening(String(body.repo || ''));
  return send(200, { ok: true });
}

export const boardRoutes: ApiRoute[] = [
  { path: '/api/board/type', method: 'POST', handle: type, boardKey: true },
  { path: '/api/board/stop-listening', method: 'POST', handle: stopListening, boardKey: true },
  { path: '/api/board/focus', method: 'POST', handle: focus, boardKey: true },
  { path: '/api/board/open-story', method: 'POST', handle: openStory, boardKey: true },
  { path: '/api/board/reviewed', method: 'POST', handle: reviewLocal, boardKey: true },
  { path: '/api/board/backlog/move', method: 'POST', handle: moveBacklog, boardKey: true },
  { path: '/api/board/backlog/drop', method: 'POST', handle: dropBacklog, boardKey: true },
  { path: '/api/board/backlog', method: 'POST', handle: addBacklog, boardKey: true },
  { path: '/api/board', method: 'GET', handle: data, boardKey: true },
  { path: '/api/board/link', method: 'GET', handle: boardLink, inboxKey: true },
  { path: '/api/board/inbox-link', method: 'GET', handle: inboxLink, boardKey: true },
];
