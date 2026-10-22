/**
 * The bridge: a small HTTP server on 127.0.0.1 that serves stories to the
 * extension and the local page, and writes what the panel sends (questions,
 * position, viewed files, notes) to the inbox and the story's state folder.
 *
 * Guard rails:
 *   - binds 127.0.0.1 only, and answers only when the Host header is
 *     127.0.0.1:<port> or localhost:<port> (no DNS rebinding)
 *   - every /api call needs the token (Authorization: Bearer <token>)
 *   - writes must be application/json, and a request with an Origin must come
 *     from the extension or from the bridge's own pages
 *   - no CORS headers, so other web pages can't read anything it says
 *
 * The routes live in ./routes/, one file per area. Each gets `app` (the
 * stores and settings below) and answers with `send`.
 */
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../stories/store.mjs';
import { readMeta } from '../stories/meta.mjs';
import { storyRepo } from '../config/repos.mjs';
import { Inbox } from '../inbox/inbox.mjs';
import { Builds } from '../inbox/builds.mjs';
import { HttpError, sameToken, readBody } from './request.mjs';
import { assetFor } from './assets.mjs';
import { pageHeaders, localPage } from './pages.mjs';
import { statusRoutes } from './routes/status.mjs';
import { catalogRoutes } from './routes/catalog.mjs';
import { buildRoutes } from './routes/builds.mjs';
import { questionRoutes } from './routes/questions.mjs';
import { storyRoutes } from './routes/story.mjs';
import { draftRoutes } from './routes/drafts.mjs';
import { readRoutes } from './routes/reads.mjs';
import { localStoryRoutes } from './routes/local-story.mjs';

export { relOfDraft } from './routes/local-story.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(
  readFileSync(path.resolve(HERE, '../../package.json'), 'utf8'),
).version;

/** /api/<path> routes, checked in order. A route with a method answers only that method. */
const API_ROUTES = [...statusRoutes, ...catalogRoutes, ...buildRoutes];
/** /api/stories/<id>/<what>[/<sub>] routes, by `what` ('' for the story itself). */
const STORY_ROUTES = [
  ...storyRoutes,
  ...questionRoutes,
  ...draftRoutes,
  ...readRoutes,
  ...localStoryRoutes,
];
const STORY_PATH = /^\/api\/stories\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const SEEN_WRITE_MS = 30000;
const HTML = 'text/html; charset=utf-8';

const methodMatches = (route, method) => !route.method || route.method === method;

/**
 * @typedef {http.Server & {stories: StoryStore, inbox: Inbox, builds: Builds}} Bridge
 *   the server, with the stores it serves from for the CLI's startup line and the tests
 */

/**
 * @param {{home: string, token: string, log?: (line: string) => void}} opts
 * @returns {Bridge} call .listen(port, '127.0.0.1')
 */
export function createBridge({
  home,
  token,
  log = (line) => process.stderr.write(`once-upon bridge: ${line}\n`),
}) {
  if (!token) {
    throw new Error('the bridge needs a token');
  }
  const stories = new StoryStore({ home });
  const inbox = new Inbox(home);
  const app = {
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
  const seeExtension = (origin) => {
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
  function servePage(req, pathname, send) {
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
      send(200, localPage(id, readMeta(dir), token), HTML, pageHeaders());
      return true;
    }
    return false;
  }

  /** The token, then the body: GET, or POST with JSON. */
  async function checkApiCall(req, origin) {
    const auth =
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      req.headers['x-once-upon-token'];
    if (!sameToken(auth, token)) {
      throw new HttpError(401, 'missing or wrong token');
    }
    if (origin && origin.startsWith('chrome-extension://')) {
      seeExtension(origin);
    }
    if (req.method === 'POST') {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(415, 'send application/json');
      }
      return readBody(req);
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'GET or POST only');
    }
    return {};
  }

  /** A /api/stories/<id>/... call: the story, then the route for its `what`. */
  function storyCall(call, match) {
    const id = decodeURIComponent(match[1]);
    const dir = stories.dirOf(id);
    if (!dir) {
      throw new HttpError(404, 'no story with that id');
    }
    const meta = readMeta(dir);
    const what = match[2] || '';
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
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...extra,
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new HttpError(421, 'wrong host');
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const origin = req.headers.origin;
      if (
        origin &&
        !EXTENSION_ORIGIN.test(origin) &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      ) {
        throw new HttpError(403, 'origin not allowed');
      }
      if (servePage(req, pathname, send)) {
        return;
      }
      if (!pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not found');
      }
      const body = await checkApiCall(req, origin);
      const call = { app, req, url, body, send };
      const route = API_ROUTES.find(
        (candidate) => candidate.path === pathname && methodMatches(candidate, req.method),
      );
      if (route) {
        return await route.handle(call);
      }
      const storyMatch = STORY_PATH.exec(pathname);
      if (!storyMatch) {
        throw new HttpError(404, 'not found');
      }
      return await storyCall(call, storyMatch);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) {
        log(err.stack || String(err));
      }
      if (!res.headersSent) {
        send(status, { error: err.message || String(err) });
      }
    }
  });
  return Object.assign(server, { stories, inbox, builds: app.builds });
}
