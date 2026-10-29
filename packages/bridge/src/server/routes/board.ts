/*
 * The agent board (../../board/board.ts): the live Claude Code sessions and the ledger's background agents.
 *
 *   GET /api/board              the lanes and their cards
 *   GET /api/board/link         the board page's link, with the board's key. Only the bridge's token (the extension, the CLI) gets it
 *   POST /api/board/type        {kind: build|listen, session, repo? | story?}: type Build story's or Start listening's line (a
 *                               story's own listener with story) into the session's iTerm tab, when the session is at its prompt
 *   GET /api/board/listen-sessions?repo= | ?story=  the idle sessions Start listening may type into for that repo (or the
 *                               story's repo): the panel's Start listening button asks this, then POSTs /type
 *   POST /api/board/voice/phone {on: boolean}: turn phone mode on or off through Larmor's voice_ctl, which starts the phone
 *                               bridge when it turns on. 409 with Larmor's reason when it refuses; it works with voice off too
 *   POST /api/board/voice/phone/bridge-stop: stop the phone bridge, which also ends phone mode (the menu bar's order)
 *   POST /api/board/voice/pause {paused: boolean}: pause or resume voice by making or removing Larmor's `paused` file, as its
 *                               menu bar does (the bridge writes the file, the page only asks). 409 to pause when voice is off
 *   POST /api/board/stop-listening  {repo}: end the repo's listener
 *   POST /api/board/focus       {session}: bring that session's iTerm tab to the front (the tab is found server-side)
 *   POST /api/board/open-story  {story}: a local story's page link (a card's Open story), with that story's full key
 *   POST /api/board/reviewed    {story, reviewed?}: mark a local story reviewed (a card's Mark reviewed), or unmark it with
 *                               reviewed: false. A local story only: PR stories are marked on GitHub
 *   POST /api/board/backlog     {title, note?, repo?}: add a backlog item (the Backlog column's Add)
 *   POST /api/board/backlog/move {id, before | edge}: reorder (before another item's id, or edge top or bottom)
 *   POST /api/board/backlog/drop {id}: drop one. Start is the CLI's (`once-upon backlog start`), not the page's
 *   POST /api/board/backlog/assign {id, session}: type the item's start line (built here from the store, the body has no
 *                               text) into an idle session in the item's repo, which then runs `once-upon backlog start`
 *   POST /api/board/worktree/clean {path, ack?, ignored?}: Clean up a worktree (board/worktree-clean.ts): `git worktree remove` without
 *                               --force, and `git branch -d` for a branch merged into the default branch (never an everfi-frontend one).
 *                               The bridge re-checks the worktree itself and refuses (409) anything dirty, in use, locked, new,
 *                               a detached HEAD no branch reaches, ignored files not confirmed, or unpushed commits not in the main line; ack "superseded" and "ignored-files" (with ignored, the names) are the page saying its confirm named those
 *
 * The board page's key reaches the board (it types into sessions). Only the bridge's token is handed the board's key.
 */
import path from 'node:path';
import { REPO_RE } from '../../config/repos.ts';
import { readSettings } from '../../config/settings.ts';
import { publicOriginOf } from '../address.ts';
import { HttpError } from '../request.ts';
import { localStory, markStoryReviewed } from '../../story-lists/stories.ts';
import { ID_PATTERN } from '../../board/backlog.ts';
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
 * 127.0.0.1, asks for `?public=1` and gets the proxy's address when that name reaches this machine.
 */
async function boardLink(call: Call) {
  const origin = call.url.searchParams.get('public')
    ? await publicOriginOf(call.app.home)
    : originOf(call);
  return call.send(200, { url: call.app.links.board(origin) });
}

async function focus({ app, body, send }: Call) {
  const session = String(body.session || '');
  if (!SESSION_RE.test(session)) {
    throw new HttpError(400, 'a session id is needed');
  }
  await app.board.focus(session);
  return send(200, { ok: true });
}

/** POST {kind: 'build' | 'listen', session, repo? | story?}: type Build story's or Start listening's line into the session's tab. */
async function type({ app, body, send }: Call) {
  const session = String(body.session || '');
  let kind: 'build' | 'listen' | null = null;
  if (body.kind === 'listen' || body.kind === 'build') {
    kind = body.kind;
  }
  if (!kind || !SESSION_RE.test(session)) {
    throw new HttpError(400, 'a kind (build or listen) and a session id are needed');
  }
  const typed = await app.board.type(
    kind,
    session,
    body.repo ? String(body.repo) : null,
    body.story ? String(body.story) : null,
  );
  return send(200, { ok: true, typed });
}

/** GET ?repo= or ?story=: the idle sessions Start listening may type into for the repo (a story's: its own repo). */
async function listenSessions({ app, url, send }: Call) {
  const storyId = url.searchParams.get('story');
  const repo = url.searchParams.get('repo');
  if (storyId) {
    // a story with a repo, or a local one with a checkout to find sessions in; else the repo asked for, if any
    const found = await app.board.storyListenSessions(storyId).catch((err: { status?: number }) => {
      if (err.status === 400 && repo) {
        return null;
      }
      throw err;
    });
    if (found) {
      return send(200, found);
    }
  }
  if (!repo || !REPO_RE.test(repo)) {
    throw new HttpError(400, 'a repo (owner/name), or a story that has one, is needed');
  }
  return send(200, { repo, sessions: await app.board.listenSessions(repo) });
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

/** POST {id, session}: Assign, the line typed into the session's tab. The session must be one the board offers for the item. */
async function assignBacklog({ app, body, send }: Call) {
  const session = String(body.session || '');
  if (!SESSION_RE.test(session) || !ID_PATTERN.test(String(body.id || ''))) {
    throw new HttpError(400, 'a backlog item id and a session id are needed');
  }
  const typed = await app.board.assignBacklog(String(body.id), session, 'board');
  return send(200, { ok: true, typed });
}

/** POST {paused}: pause (true) or resume (false) voice. */
function voicePause({ app, body, send }: Call) {
  if (typeof body.paused !== 'boolean') {
    throw new HttpError(400, 'paused (true or false) is needed');
  }
  app.board.setVoicePaused(body.paused);
  return send(200, { ok: true, paused: body.paused });
}

/** POST {on}: phone mode on or off. */
async function voicePhone({ app, body, send }: Call) {
  if (typeof body.on !== 'boolean') {
    throw new HttpError(400, 'on (true or false) is needed');
  }
  const got = await app.board.setPhone(body.on ? 'phone-on' : 'phone-off');
  return send(200, { ok: true, ...got });
}

/** POST: stop the phone bridge (and so phone mode). */
async function voiceBridgeStop({ app, send }: Call) {
  const got = await app.board.setPhone('bridge-stop');
  return send(200, { ok: true, ...got });
}

/** POST {path, ack?}: Clean up a worktree the board lists. Everything but the path is the bridge's own look at it. */
async function cleanWorktree({ app, body, send }: Call) {
  const dir = String(body.path || '');
  if (!path.isAbsolute(dir)) {
    throw new HttpError(400, 'the worktree path is needed');
  }
  // ack: what the confirm said ("superseded", "ignored-files"), a string or a list; ignored: the file names it showed
  const list = (value: unknown): string[] => {
    const items = Array.isArray(value) ? value : [value];
    return items
      .filter((item) => item !== undefined && item !== null && item !== '')
      .map(String)
      .slice(0, 100);
  };
  const result = await app.board.cleanWorktree(dir, list(body.ack), list(body.ignored));
  return send(200, { ok: true, ...result });
}

/** POST {repo}: end the repo's listener (its `wait` returns "Stopped listening"). */
function stopListening({ app, body, send }: Call) {
  app.board.stopListening(String(body.repo || ''));
  return send(200, { ok: true });
}

export const boardRoutes: ApiRoute[] = [
  { path: '/api/board/type', method: 'POST', handle: type, boardKey: true },
  { path: '/api/board/listen-sessions', method: 'GET', handle: listenSessions, boardKey: true },
  { path: '/api/board/voice/pause', method: 'POST', handle: voicePause, boardKey: true },
  { path: '/api/board/voice/phone', method: 'POST', handle: voicePhone, boardKey: true },
  {
    path: '/api/board/voice/phone/bridge-stop',
    method: 'POST',
    handle: voiceBridgeStop,
    boardKey: true,
  },
  { path: '/api/board/stop-listening', method: 'POST', handle: stopListening, boardKey: true },
  { path: '/api/board/focus', method: 'POST', handle: focus, boardKey: true },
  { path: '/api/board/open-story', method: 'POST', handle: openStory, boardKey: true },
  { path: '/api/board/reviewed', method: 'POST', handle: reviewLocal, boardKey: true },
  { path: '/api/board/backlog/move', method: 'POST', handle: moveBacklog, boardKey: true },
  { path: '/api/board/backlog/drop', method: 'POST', handle: dropBacklog, boardKey: true },
  { path: '/api/board/worktree/clean', method: 'POST', handle: cleanWorktree, boardKey: true },
  { path: '/api/board/backlog/assign', method: 'POST', handle: assignBacklog, boardKey: true },
  { path: '/api/board/backlog', method: 'POST', handle: addBacklog, boardKey: true },
  { path: '/api/board', method: 'GET', handle: data, boardKey: true },
  { path: '/api/board/link', method: 'GET', handle: boardLink },
];
