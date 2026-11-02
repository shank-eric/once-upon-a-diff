/*
 * The agent board (../../services/board/board.ts): the live Claude Code sessions and the ledger's background agents.
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
 *   POST /api/board/agent/finish {sid, name}: Finish on a finished agent's card in Waiting: the card leaves the board now and
 *                               returns only if the agent does something more. The agent is looked up in the ledger; a
 *                               `[waiting]` one gets a `[done]` line there. 409 for one still working or parked on your story review
 *   POST /api/board/worktree/clean {path, ack?, ignored?}: Clean up a worktree (services/worktrees/worktree-clean.ts): `git worktree remove` without
 *                               --force, and `git branch -d` for a branch merged into the default branch (never an everfi-frontend one).
 *                               The bridge re-checks the worktree itself and refuses (409) anything dirty, in use, locked, new,
 *                               a detached HEAD no branch reaches, ignored files not confirmed, or unpushed commits not in the main line; ack "superseded" and "ignored-files" (with ignored, the names) are the page saying its confirm named those
 *
 * The board page's key reaches the board (it types into sessions). Only the bridge's token is handed the board's key.
 */
import path from 'node:path';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { REPO_RE } from '../../services/config/repos.ts';
import { readSettings } from '../../services/config/settings.ts';
import { publicOriginOf } from '../../services/pages/address.ts';
import { BoardError } from '../../services/errors.ts';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { localStory, markStoryReviewed } from '../../services/review/story-lists.ts';
import type { MoveTo } from '../../services/backlog/backlog.ts';
import type { ApiRoute, Call } from '../types.ts';

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
  await app.sessions.focus(parseBody('boardFocus', body).session);
  return send(200, { ok: true });
}

/** POST {kind: 'build' | 'listen', session, repo? | story?}: type Build story's or Start listening's line into the session's tab. */
async function type({ app, body: raw, send }: Call) {
  const { kind, session, repo, story } = parseBody('boardType', raw);
  const typed = await app.sessions.type(kind, session, repo || null, story || null);
  return send(200, { ok: true, typed });
}

/** GET ?repo= or ?story=: the idle sessions Start listening may type into for the repo (a story's: its own repo). */
async function listenSessions({ app, url, send }: Call) {
  const storyId = url.searchParams.get('story');
  const repo = url.searchParams.get('repo');
  if (storyId) {
    // a story with a repo, or a local one with a checkout to find sessions in; else the repo asked for, if any
    const found = await app.sessions.storyListenSessions(storyId).catch((err: unknown) => {
      if (err instanceof BoardError && err.status === 400 && repo) {
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
  return send(200, { repo, sessions: await app.sessions.listenSessions(repo) });
}

/** POST {story}: the page link of a local story on a card, which has no URL of its own like a PR story's. */
function openStory({ app, body, send }: Call) {
  const story = localStory(app.stories, parseBody('boardOpenStory', body).story);
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
function reviewLocal({ app, body: raw, send }: Call) {
  const { story: id, reviewed } = parseBody('boardReviewed', raw);
  if (!localStory(app.stories, id)) {
    throw new HttpError(404, 'no local story with that id');
  }
  markStoryReviewed(app.stories, id, reviewed !== false);
  return send(200, { ok: true });
}

/** POST {title, note?, repo?}: a new backlog item, by "board". */
function addBacklog({ app, body: raw, send }: Call) {
  const { title, note, repo } = parseBody('boardBacklogAdd', raw);
  const item = asBadRequest(() =>
    app.board.addBacklog({ title, note: note || null, repo: repo || null, by: 'board' }),
  );
  return send(200, { ok: true, id: item.id });
}

/** POST {id, before | edge}: put a backlog item before another, or at the top or bottom. */
function moveBacklog({ app, body: raw, send }: Call) {
  const { id, before, edge } = parseBody('boardBacklogMove', raw);
  const where: MoveTo = before ? { before } : { edge: edge === 'top' ? 'top' : 'bottom' };
  asBadRequest(() => app.board.moveBacklog(id, where, 'board'));
  return send(200, { ok: true });
}

/** POST {id}: drop a backlog item. The line stays in the file. */
function dropBacklog({ app, body, send }: Call) {
  const { id } = parseBody('boardBacklogDrop', body);
  asBadRequest(() => app.board.dropBacklog(id, 'board'));
  return send(200, { ok: true });
}

/** POST {id, session}: Assign, the line typed into the session's tab. The session must be one the board offers for the item. */
async function assignBacklog({ app, body: raw, send }: Call) {
  const { id, session } = parseBody('boardBacklogAssign', raw);
  const typed = await app.board.assignBacklog(id, session, 'board');
  return send(200, { ok: true, typed });
}

/** POST {paused}: pause (true) or resume (false) voice. */
function voicePause({ app, body: raw, send }: Call) {
  const { paused } = parseBody('boardVoicePause', raw);
  app.board.setVoicePaused(paused);
  return send(200, { ok: true, paused });
}

/** POST {on}: phone mode on or off. */
async function voicePhone({ app, body: raw, send }: Call) {
  const { on } = parseBody('boardVoicePhone', raw);
  const got = await app.board.setPhone(on ? 'phone-on' : 'phone-off');
  return send(200, { ok: true, ...got });
}

/** POST: stop the phone bridge (and so phone mode). */
async function voiceBridgeStop({ app, send }: Call) {
  const got = await app.board.setPhone('bridge-stop');
  return send(200, { ok: true, ...got });
}

/** POST {path, ack?}: Clean up a worktree the board lists. Everything but the path is the bridge's own look at it. */
async function cleanWorktree({ app, body: raw, send }: Call) {
  // ack: what the confirm said ("superseded", "ignored-files"); ignored: the file names it showed
  const { path: dir, ack, ignored } = parseBody('boardWorktreeClean', raw);
  if (!path.isAbsolute(dir)) {
    throw new HttpError(400, 'the worktree path is needed');
  }
  const result = await app.board.cleanWorktree(dir, ack, ignored);
  return send(200, { ok: true, ...result });
}

/** POST {sid, name}: Finish a finished agent's card (the bridge looks the agent up in the ledger itself). */
function finishAgent({ app, body, send }: Call) {
  const { sid, name } = parseBody('boardAgentFinish', body);
  return send(200, { ok: true, ...app.board.finishAgent(sid, name) });
}

/** POST {repo}: end the repo's listener (its `wait` returns "Stopped listening"). */
function stopListening({ app, body, send }: Call) {
  app.board.stopListening(parseBody('boardStopListening', body).repo);
  return send(200, { ok: true });
}

export const boardRoutes: ApiRoute[] = [
  { route: ROUTES.boardType, handle: type },
  { route: ROUTES.boardListenSessions, handle: listenSessions },
  { route: ROUTES.boardVoicePause, handle: voicePause },
  { route: ROUTES.boardVoicePhone, handle: voicePhone },
  { route: ROUTES.boardVoiceBridgeStop, handle: voiceBridgeStop },
  { route: ROUTES.boardStopListening, handle: stopListening },
  { route: ROUTES.boardAgentFinish, handle: finishAgent },
  { route: ROUTES.boardFocus, handle: focus },
  { route: ROUTES.boardOpenStory, handle: openStory },
  { route: ROUTES.boardReviewed, handle: reviewLocal },
  { route: ROUTES.boardBacklogMove, handle: moveBacklog },
  { route: ROUTES.boardBacklogDrop, handle: dropBacklog },
  { route: ROUTES.boardWorktreeClean, handle: cleanWorktree },
  { route: ROUTES.boardBacklogAssign, handle: assignBacklog },
  { route: ROUTES.boardBacklogAdd, handle: addBacklog },
  { route: ROUTES.board, handle: data },
  { route: ROUTES.boardLink, handle: boardLink },
];
