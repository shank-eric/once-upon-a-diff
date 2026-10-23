/**
 * The bridge: a small HTTP server on 127.0.0.1 that serves stories to the
 * extension and the local page, and writes what the panel sends (questions,
 * position, viewed files, notes, fix requests) to the inbox and the story's state folder.
 *
 * Guard rails:
 *   - binds 127.0.0.1 only, and answers only when the Host header is
 *     127.0.0.1:<port> or localhost:<port> (no DNS rebinding)
 *   - every /api call needs the token (Authorization: Bearer <token>), or for a local page's own story only,
 *     that story's page key (./page-key.ts), which can't reach other stories, bridge-wide routes or GitHub's
 *     API. Its one way out to GitHub is Create pull request's `git push` of the story's branch, which the page
 *     sends only from the reviewer's click in its confirm box (routes/pull-request.ts)
 *   - writes must be application/json, and a request with an Origin must come
 *     from this extension (its fixed ID, or one in extension_ids) or from the bridge's own pages
 *   - no CORS headers, so other web pages can't read anything it says
 *
 * The routes live in ./routes/, one file per area. Each gets `app` (the
 * stores and settings below) and answers with `send`.
 */
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../stories/store.ts';
import { readMeta } from '../stories/meta.ts';
import { storyRepo } from '../config/repos.ts';
import { Inbox } from '../inbox/inbox.ts';
import { Builds } from '../inbox/builds.ts';
import { HttpError, sameToken, readBody } from './request.ts';
import { assetFor } from './assets.ts';
import { pageHeaders, localPage } from './pages.ts';
import { PAGE_KEY_PREFIX, pageKey } from './page-key.ts';
import { statusRoutes, storyStatusRoutes } from './routes/status.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { buildRoutes } from './routes/builds.ts';
import { questionRoutes } from './routes/questions.ts';
import { storyRoutes } from './routes/story.ts';
import { draftRoutes } from './routes/drafts.ts';
import { readRoutes } from './routes/reads.ts';
import { localStoryRoutes } from './routes/local-story.ts';
import { fixRoutes } from './routes/fixes.ts';
import { pullRequestRoutes } from './routes/pull-request.ts';
import { UNPACKED_EXTENSION_ID } from '../config/settings.ts';
import type { ApiRoute, App, Body, Call, Send, StoryRoute } from '../types.ts';

export { relOfPath } from '../util/diff.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(
  readFileSync(path.resolve(HERE, '../../package.json'), 'utf8'),
).version;

/** /api/<path> routes, checked in order. A route with a method answers only that method. */
const API_ROUTES: ApiRoute[] = [...statusRoutes, ...catalogRoutes, ...buildRoutes];
/** /api/stories/<id>/<what>[/<sub>] routes, by `what` ('' for the story itself). */
const STORY_ROUTES: StoryRoute[] = [
  ...storyRoutes,
  ...questionRoutes,
  ...draftRoutes,
  ...readRoutes,
  ...localStoryRoutes,
  ...fixRoutes,
  ...pullRequestRoutes,
  ...storyStatusRoutes,
];
const STORY_PATH = /^\/api\/stories\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/;
const SEEN_WRITE_MS = 30000;
const HTML = 'text/html; charset=utf-8';

const methodMatches = (route: { method?: string }, method: string | undefined) =>
  !route.method || route.method === method;

/** The server, with the stores it serves from, for the CLI's startup line and the tests. Call .listen(port, '127.0.0.1'). */
export type Bridge = http.Server & { stories: StoryStore; inbox: Inbox; builds: Builds };

export function createBridge({
  home,
  token,
  log = (line) => process.stderr.write(`once-upon bridge: ${line}\n`),
  extensionIds = [UNPACKED_EXTENSION_ID],
}: {
  home: string;
  token: string;
  log?: (line: string) => void;
  /** the extension IDs whose pages may call it (readSettings' extensionIds) */
  extensionIds?: string[];
}): Bridge {
  const extensionOrigins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  if (!token) {
    throw new Error('the bridge needs a token');
  }
  const stories = new StoryStore({ home });
  const inbox = new Inbox(home);
  const app: App = {
    home,
    version: VERSION,
    stories,
    inbox,
    builds: new Builds(home),
    log,
    statusCache: null, // PR-list lookups, kept 5s
    extensionSeen: null, // the last time the extension talked to us, for `once-upon doctor` and the status light
  };
  let extensionWritten = 0;
  const seeExtension = (origin: string) => {
    app.extensionSeen = { at: new Date().toISOString(), origin };
    if (Date.now() - extensionWritten > SEEN_WRITE_MS) {
      extensionWritten = Date.now();
      try {
        writeFileSync(path.join(home, 'extension-seen.json'), JSON.stringify(app.extensionSeen));
      } catch {
        /* not worth failing a request over */
      }
    }
  };

  /** The pages and assets, which need no token. Returns true when it answered. */
  function servePage(req: IncomingMessage, pathname: string, send: Send): boolean {
    if (req.method !== 'GET') {
      return false;
    }
    const asset = assetFor(pathname);
    if (asset) {
      send(200, asset[0], asset[1]);
      return true;
    }
    const localPath = /^\/local\/([^/]+)\/?$/.exec(pathname);
    if (localPath) {
      const id = decodeURIComponent(localPath[1]);
      const dir = stories.dirOf(id);
      if (!dir || readMeta(dir).kind !== 'local') {
        throw new HttpError(404, 'no local story with that id');
      }
      send(200, localPage(id, readMeta(dir)), HTML, pageHeaders());
      return true;
    }
    return false;
  }

  /**
   * The token, then the body: GET, or POST with JSON. Returns the body and the call's scope: null with the bridge's
   * token, or the one story a local page's key is for.
   */
  async function checkApiCall(
    req: IncomingMessage,
    pathname: string,
    origin: string | undefined,
  ): Promise<{ body: Body; scope: string | null }> {
    const auth = String(
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        req.headers['x-once-upon-token'] ||
        '',
    );
    let scope: string | null = null;
    if (!sameToken(auth, token)) {
      if (!auth.startsWith(PAGE_KEY_PREFIX)) {
        throw new HttpError(401, 'missing or wrong token');
      }
      const storyMatch = STORY_PATH.exec(pathname);
      const id = storyMatch ? decodeURIComponent(storyMatch[1]) : null;
      if (!id || !sameToken(auth, pageKey(token, id))) {
        throw new HttpError(403, "this page's key works only for its own story");
      }
      scope = id;
    }
    if (origin && origin.startsWith('chrome-extension://')) {
      seeExtension(origin);
    }
    if (req.method === 'POST') {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(415, 'send application/json');
      }
      return { body: await readBody(req), scope };
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'GET or POST only');
    }
    return { body: {}, scope };
  }

  /** A /api/stories/<id>/... call: the story, then the route for its `what`. */
  function storyCall(call: Call, match: RegExpExecArray, scope: string | null) {
    const id = decodeURIComponent(match[1]);
    const dir = stories.dirOf(id);
    if (!dir) {
      throw new HttpError(404, 'no story with that id');
    }
    const meta = readMeta(dir);
    const what = match[2] || '';
    // a page key is only ever handed to a local story's page, and never reaches GitHub's API (Add to my review)
    if (scope && (meta.kind !== 'local' || (what === 'drafts' && call.body.action === 'review'))) {
      throw new HttpError(403, "this page's key can't do that");
    }
    // ref: what inbox entries say about the story, with the repo for `wait --repo`
    const ref = { story: id, kind: meta.kind, title: meta.title, repo: storyRepo(meta) };
    const story = { id, dir, meta, ref, sub: match[3] };
    const route = STORY_ROUTES.find(
      (candidate) => candidate.what === what && methodMatches(candidate, call.req.method),
    );
    if (!route) {
      throw new HttpError(404, 'not found');
    }
    return route.handle(call, story);
  }

  const server = http.createServer(async (req, res) => {
    const send: Send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...extra,
      });
      res.end(
        type.startsWith('application/json') ? JSON.stringify(body) : (body as string | Buffer),
      );
    };
    try {
      const port = (server.address() as AddressInfo).port;
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new HttpError(421, 'wrong host');
      }
      const url = new URL(req.url as string, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const origin = req.headers.origin;
      if (
        origin &&
        !extensionOrigins.has(origin) &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      ) {
        throw new HttpError(
          403,
          origin.startsWith('chrome-extension://')
            ? `origin not allowed: add ${origin.slice('chrome-extension://'.length)} to extension_ids in ~/.once-upon/config.json if it's your copy of Once Upon a Diff`
            : 'origin not allowed',
        );
      }
      if (servePage(req, pathname, send)) {
        return;
      }
      if (!pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not found');
      }
      const { body, scope } = await checkApiCall(req, pathname, origin);
      const call: Call = { app, req, url, body, send };
      // a page key never reaches the bridge-wide routes, even one whose path looks like a story's
      const route =
        !scope &&
        API_ROUTES.find(
          (candidate) => candidate.path === pathname && methodMatches(candidate, req.method),
        );
      if (route) {
        return await route.handle(call);
      }
      const storyMatch = STORY_PATH.exec(pathname);
      if (!storyMatch) {
        throw new HttpError(404, 'not found');
      }
      return await storyCall(call, storyMatch, scope);
    } catch (caught) {
      const err = caught as Error & { status?: number };
      const status = err.status || 500;
      if (status === 500) {
        log(err.stack || String(err));
      }
      if (!res.headersSent) {
        // a 413's body may still be arriving: close once the answer is out rather than read the rest
        const extra: Record<string, string> = status === 413 ? { Connection: 'close' } : {};
        send(status, { error: err.message || String(err) }, undefined, extra);
      }
    }
  });
  return Object.assign(server, { stories, inbox, builds: app.builds });
}
