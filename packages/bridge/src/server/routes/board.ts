/*
 * The agent board (../../board/board.ts): the live Claude Code sessions and the ledger's background agents.
 *
 *   GET /api/board              the lanes and their cards
 *   GET /api/board/link         the board page's link, for the inbox page (which can't make a key itself)
 *   POST /api/board/type        {kind: build|listen, session, repo?}: type Build story's or Start listening's line into the
 *                               session's iTerm tab, when the session is at its prompt
 *   POST /api/board/stop-listening  {repo}: end the repo's listener
 *   POST /api/board/focus       {session}: bring that session's iTerm tab to the front (the tab is found server-side)
 *   GET /api/board/inbox-link   the review inbox page's link, ?session= for one session's turns and ?repo= for a repo's
 *                               turns and PR stories, for a card's badge
 *
 * The board page's key reaches the board and the inbox link, the inbox page's key the board link. All of it is read
 * only. The board never reaches a session or a story: its links hand out the other pages' own keys, the way
 * /api/turns/open hands out a story's.
 */
import { REPO_RE } from '../../config/repos.ts';
import { readSettings } from '../../config/settings.ts';
import { publicOriginOf } from '../address.ts';
import { HttpError } from '../request.ts';
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
 * 127.0.0.1, asks for `?public=1` and gets the proxy's address when that name reaches this machine.
 */
async function boardLink(call: Call) {
  const origin = call.url.searchParams.get('public')
    ? await publicOriginOf(call.app.home)
    : originOf(call);
  return call.send(200, { url: call.app.links.board(origin) });
}

function inboxLink(call: Call) {
  const { app, url, send } = call;
  const session = url.searchParams.get('session');
  const repo = url.searchParams.get('repo');
  return send(200, {
    url: app.links.inbox(
      repo && REPO_RE.test(repo) ? repo : null,
      session && SESSION_RE.test(session) ? session : null,
      originOf(call),
    ),
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

/** POST {repo}: end the repo's listener (its `wait` returns "Stopped listening"). */
function stopListening({ app, body, send }: Call) {
  app.board.stopListening(String(body.repo || ''));
  return send(200, { ok: true });
}

export const boardRoutes: ApiRoute[] = [
  { path: '/api/board/type', method: 'POST', handle: type, boardKey: true },
  { path: '/api/board/stop-listening', method: 'POST', handle: stopListening, boardKey: true },
  { path: '/api/board/focus', method: 'POST', handle: focus, boardKey: true },
  { path: '/api/board', method: 'GET', handle: data, boardKey: true },
  { path: '/api/board/link', method: 'GET', handle: boardLink, inboxKey: true },
  { path: '/api/board/inbox-link', method: 'GET', handle: inboxLink, boardKey: true },
];
