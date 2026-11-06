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
 *     sends only from the reviewer's click in its confirm box (routes/pull-request.ts). A story also has a read-only
 *     key that reaches only an allowlist of routes (viewKeyMay in ./page-key.ts), so
 *     it can't push at all, and a route added later is refused to it until it is listed
 *   - the agent board page's key (./page-key.ts) reaches only the routes that allow it (routes/board.ts)
 *   - writes must be application/json, and a request with an Origin must come
 *     from this extension (its fixed ID, or one in extension_ids) or from the bridge's own pages
 *   - no CORS headers, so other web pages can't read anything it says
 *
 * The routes live in ./routes/, one file per area. Each gets `app` (the
 * stores and settings below) and answers with `send`.
 */
import http, { type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readMeta, storyRepo } from '@once-upon-a-diff/stories/meta';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import {
  announceBridge,
  retireBridge,
  writeExtensionSeen,
} from '@once-upon-a-diff/core/orchestration/bridge/bridge';
import { Board } from '@once-upon-a-diff/board/board';
import { BoardError } from '@once-upon-a-diff/foundation/errors';
import { codeOfStatus } from '@once-upon-a-diff/terms/error-code';
import { HttpError, sameToken, readBody } from './request.ts';
import { COOKIE_NAMES, cookieFor, cookiesOf } from './session-cookie.ts';
import { assetFor } from './assets.ts';
import { parseBody } from './validate.ts';
import { boardKeyMay } from '@once-upon-a-diff/contracts/routes';
import { pageHeaders, localPage, boardPage } from './pages.ts';
import {
  PAGE_KEY_PREFIX,
  boardKey,
  boardPageUrl,
  localPageUrl,
  pageKey,
  viewKey,
  viewKeyMay,
} from '@once-upon-a-diff/state/records/page-links/page-key';
import { statusRoutes, storyStatusRoutes } from './routes/status.ts';
import { usageRoutes, storyUsageRoutes } from './routes/usage.ts';
import { ROUTES, type AnyRoute } from '@once-upon-a-diff/contracts/routes';
import { UNMATCHED, UsageCounters, type Surface } from '@once-upon-a-diff/usage/counters';
import { bridgeListening, onUsageFlush } from '@once-upon-a-diff/usage/capture';
import { countingEnabled } from '@once-upon-a-diff/usage/enabled';
import { catalogRoutes } from './routes/catalog.ts';
import { buildRoutes } from './routes/builds.ts';
import { questionRoutes } from './routes/questions.ts';
import { storyRoutes } from './routes/story.ts';
import { draftRoutes } from './routes/drafts.ts';
import { readRoutes } from './routes/reads.ts';
import { localStoryRoutes } from './routes/local-story.ts';
import { fixRoutes } from './routes/fixes.ts';
import { pullRequestRoutes } from './routes/pull-request.ts';
import { pushRoutes } from './routes/push.ts';
import { boardRoutes } from './routes/board.ts';
import { githubRoutes } from './routes/github.ts';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import {
  ghBranchCheck,
  ghPrCheck,
  ghRequestedCheck,
  type BranchCheck,
  type PrCheck,
  type RequestedCheck,
} from '@once-upon-a-diff/state/records/github/github-checks';
import { UNPACKED_EXTENSION_ID, readSettings } from '@once-upon-a-diff/foundation/settings';
import type { ApiRoute, App, Body, Call, Send, StoryRoute } from './types.ts';

export { relOfPath } from '@once-upon-a-diff/stories/diff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(
  readFileSync(path.resolve(HERE, '../package.json'), 'utf8'),
).version;

/** /api/<path> routes (each is an entry in the contracts package's route table), checked in order. A route answers only its method. */
export const API_ROUTES: ApiRoute[] = [
  ...statusRoutes,
  ...catalogRoutes,
  ...buildRoutes,
  ...boardRoutes,
  ...githubRoutes,
  ...usageRoutes,
];
/** /api/stories/<id>/<what>[/<sub>] routes, by `what` ('' for the story itself). */
export const STORY_ROUTES: StoryRoute[] = [
  ...storyRoutes,
  ...questionRoutes,
  ...draftRoutes,
  ...readRoutes,
  ...localStoryRoutes,
  ...fixRoutes,
  ...pullRequestRoutes,
  ...pushRoutes,
  ...storyStatusRoutes,
  ...storyUsageRoutes,
];
/** A route's key in the contracts package's table, for the usage counts (the object the handlers hold is the table's own). */
const ROUTE_KEY = new Map<AnyRoute, string>(
  Object.entries(ROUTES).map(([key, route]) => [route as AnyRoute, key]),
);
/** The usage routes are not counted as use: they are the counting. */
const NOT_COUNTED = new Set<AnyRoute>([ROUTES.usageCount, ROUTES.storyUsageCount] as AnyRoute[]);
const STORY_PATH = /^\/api\/stories\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/;
const SEEN_WRITE_MS = 30000;
const HTML = 'text/html; charset=utf-8';

/** The server, with the stores it serves from, for the CLI's startup line and the tests. Call .listen(port, '127.0.0.1'). */
export type Bridge = http.Server & {
  stories: StoryStore;
  inbox: Inbox;
  builds: Builds;
  board: Board;
  autoReview: AutoReview;
  /** the usage capture's counts (the tests flush them to read them back) */
  usage: UsageCounters;
};

export function createBridge({
  home,
  token,
  log = (line) => process.stderr.write(`once-upon bridge: ${line}\n`),
  extensionIds = [UNPACKED_EXTENSION_ID],
  checkPr = ghPrCheck,
  checkBranch = ghBranchCheck,
  checkRequested = ghRequestedCheck,
  now = Date.now,
}: {
  home: string;
  token: string;
  log?: (line: string) => void;
  /** the extension IDs whose pages may call it (readSettings' extensionIds) */
  extensionIds?: string[];
  /** how the inbox asks GitHub whether you've reviewed a PR (the tests' stand-in) */
  checkPr?: PrCheck;
  /** how the board asks GitHub which PR a branch has (the tests' stand-in) */
  checkBranch?: BranchCheck;
  /** how the board asks GitHub which PRs wait on your review (the tests' stand-in) */
  checkRequested?: RequestedCheck;
  /** the clock the GitHub refresh route measures its gaps and per-minute cap by (the tests' stand-in) */
  now?: () => number;
}): Bridge {
  const extensionOrigins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  if (!token) {
    throw new Error('the bridge needs a token');
  }
  const stories = new StoryStore({ home });
  const inbox = new Inbox(home);
  const autoReview = new AutoReview(stories, checkPr, undefined, checkBranch, checkRequested, home);
  const builds = new Builds(home);
  const board = new Board(home, stories, autoReview, builds);
  const portOf = () => (server.address() as { port: number }).port;
  const app: App = {
    home,
    version: VERSION,
    stories,
    inbox,
    builds,
    board,
    sessions: board.sessions,
    autoReview,
    now,
    links: {
      story: (id, readOnly = false) => localPageUrl(portOf(), id, token, readOnly),
      board: (origin) => boardPageUrl(portOf(), token, origin),
    },
    log,
    statusCache: null, // PR-list lookups, kept 5s
    extensionSeen: null, // the last time the extension talked to us, for `once-upon doctor` and the status light
    usage: new UsageCounters(home, new Set(ROUTE_KEY.values()), countingEnabled(home)),
  };
  // a flush of the capture (a signal, a shutdown) writes the counts too
  const unhookUsage = onUsageFlush((stamp) => app.usage.flush(stamp));
  let extensionWritten = 0;
  const seeExtension = (origin: string) => {
    app.extensionSeen = { at: new Date().toISOString(), origin };
    if (Date.now() - extensionWritten > SEEN_WRITE_MS) {
      extensionWritten = Date.now();
      try {
        writeExtensionSeen(home, app.extensionSeen);
      } catch {
        /* not worth failing a request over */
      }
    }
  };

  /** The Host the request names when it is one of config.json's allowed_hosts (read on each request), else null. */
  function allowedHostOf(req: IncomingMessage): string | null {
    const host = String(req.headers.host || '').toLowerCase();
    return readSettings(home).allowedHosts.includes(host) ? host : null;
  }

  /**
   * POST /auth/session {key}: a page on an allowed host name hands over the key from its link's #fragment, and the answer
   * sets the cookie that keeps it for that host. The key has to be the board's page key (the bridge's token
   * and a story's key don't qualify), and the request has to come from that host's own page.
   */
  async function startSession(req: IncomingMessage, origin: string | undefined, send: Send) {
    const host = allowedHostOf(req);
    if (!host) {
      // on the bridge's own address there is no https cookie to set: the page keeps its key in the fragment
      send(200, { cookie: false });
      return;
    }
    if (origin !== `https://${host}` && origin !== `http://${host}`) {
      throw new HttpError(403, 'origin not allowed');
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new HttpError(415, 'send application/json');
    }
    const { key } = parseBody('authSession', await readBody(req));
    let name: string | null = null;
    if (key.startsWith(PAGE_KEY_PREFIX) && sameToken(key, boardKey(token))) {
      name = COOKIE_NAMES.board;
    }
    if (!name) {
      throw new HttpError(403, "that key isn't the board's");
    }
    if (origin !== `https://${host}`) {
      // a page on plain http is let in, but a browser refuses a Secure __Host- cookie there: say there is none, so the page keeps its key
      send(200, { cookie: false });
      return;
    }
    send(200, { cookie: true }, undefined, { 'Set-Cookie': cookieFor(name, key) });
  }

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
    if (/^\/board\/?$/.test(pathname)) {
      send(200, boardPage(), HTML, pageHeaders());
      return true;
    }
    return false;
  }

  /**
   * The token, then the body: GET, or POST with JSON. Returns the body and the call's scope: null with the bridge's
   * token, or the one story a local page's key is for (`readOnly` when that is the story's read-only key). `pageScope` is the agent board's page
   * key: no story, and only the routes that allow it.
   */
  async function checkApiCall(
    req: IncomingMessage,
    pathname: string,
    origin: string | undefined,
  ): Promise<{
    body: Body;
    scope: string | null;
    pageScope: 'board' | null;
    readOnly: boolean;
  }> {
    let auth = String(
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        req.headers['x-once-upon-token'] ||
        '',
    );
    // no key in a header: the page key in the cookie a page on an allowed host name set (session-cookie.ts)
    let viaCookie = false;
    if (!auth && allowedHostOf(req)) {
      const jar = cookiesOf(req);
      const cookieKey = jar[COOKIE_NAMES.board] || '';
      if (cookieKey) {
        auth = cookieKey;
        viaCookie = true;
      }
    }
    let scope: string | null = null;
    let readOnly = false;
    let pageScope: 'board' | null = null;
    if (auth.startsWith(PAGE_KEY_PREFIX) && sameToken(auth, boardKey(token))) {
      pageScope = 'board';
    } else if (!sameToken(auth, token)) {
      if (!auth.startsWith(PAGE_KEY_PREFIX)) {
        throw new HttpError(401, 'missing or wrong token');
      }
      const storyMatch = STORY_PATH.exec(pathname);
      const id = storyMatch ? decodeURIComponent(storyMatch[1]) : null;
      if (!id) {
        throw new HttpError(403, "this page's key works only for its own story");
      }
      if (sameToken(auth, pageKey(token, id))) {
        scope = id;
      } else if (sameToken(auth, viewKey(token, id))) {
        scope = id;
        readOnly = true;
      } else {
        throw new HttpError(403, "this page's key works only for its own story");
      }
    }
    if (origin && origin.startsWith('chrome-extension://')) {
      seeExtension(origin);
    }
    // a cookie rides along on any request to the host, so a write it authenticates has to say where it came from
    if (viaCookie && req.method === 'POST' && !origin) {
      throw new HttpError(403, 'a write needs an Origin');
    }
    if (req.method === 'POST') {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(415, 'send application/json');
      }
      return { body: await readBody(req), scope, pageScope, readOnly };
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'GET or POST only');
    }
    return { body: {}, scope, pageScope, readOnly };
  }

  /** Who made a call that got past the key check, for the usage counts. */
  function surfaceOf(
    origin: string | undefined,
    scope: string | null,
    pageScope: 'board' | null,
    readOnly: boolean,
  ): Surface {
    if (pageScope) {
      return 'board';
    }
    if (scope) {
      return readOnly ? 'local-view' : 'local';
    }
    return origin?.startsWith('chrome-extension://') ? 'extension' : 'token';
  }

  /** Counts a call that got past the key check, under its route's key (`unmatched` when it has none, never its path). */
  function countCall(route: AnyRoute | null, surface: Surface) {
    if (route && NOT_COUNTED.has(route)) {
      return;
    }
    app.usage.route(route ? (ROUTE_KEY.get(route) ?? UNMATCHED) : UNMATCHED, surface);
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
    // the read-only key reaches only what page-key.ts lists (it reads, asks, marks viewed, takes and sends Fix before
    // push notes, and may look where the branch's PR stands), and nothing a later route adds until it is listed there
    if (call.readOnly && !viewKeyMay(what, call.req.method as string)) {
      throw new HttpError(
        403,
        'this link is read-only: open the story from the board or `once-upon page` to do that',
      );
    }
    // ref: what inbox entries say about the story, with the repo for `wait --repo`
    const ref = { story: id, kind: meta.kind, title: meta.title, repo: storyRepo(meta) };
    const story = { id, dir, meta, ref, sub: match[3] };
    const route = STORY_ROUTES.find(
      (candidate) => candidate.route.what === what && candidate.route.method === call.req.method,
    );
    countCall(route?.route ?? null, call.surface);
    if (!route) {
      throw new HttpError(404, 'not found', 'no_route');
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
      const port = (server.address() as { port: number }).port;
      const host = String(req.headers.host || '').toLowerCase();
      // the bridge's own address, or a name allowed in config.json (allowed_hosts) that a proxy forwards: exact names only
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && !allowedHostOf(req)) {
        throw new HttpError(421, 'wrong host');
      }
      const url = new URL(req.url as string, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const origin = req.headers.origin;
      if (
        origin &&
        !extensionOrigins.has(origin) &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}` &&
        !(
          allowedHostOf(req) &&
          (origin === `https://${allowedHostOf(req)}` || origin === `http://${allowedHostOf(req)}`)
        )
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
      if (req.method === 'POST' && pathname === '/auth/session') {
        return await startSession(req, origin, send);
      }
      if (!pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not found', 'no_route');
      }
      const { body, scope, pageScope, readOnly } = await checkApiCall(req, pathname, origin);
      const surface = surfaceOf(origin, scope, pageScope, readOnly);
      const call: Call = { app, req, url, body, send, pageScope, readOnly, surface };
      // a page key never reaches the bridge-wide routes, even one whose path looks like a story's
      const route =
        !scope &&
        API_ROUTES.find(
          (candidate) =>
            candidate.route.path === pathname &&
            candidate.route.method === req.method &&
            (!pageScope || boardKeyMay(candidate.route)),
        );
      if (route) {
        countCall(route.route, surface);
        return await route.handle(call);
      }
      if (pageScope) {
        throw new HttpError(
          403,
          `the ${pageScope} page's key works only for the ${pageScope}'s routes`,
        );
      }
      const storyMatch = STORY_PATH.exec(pathname);
      if (!storyMatch) {
        countCall(null, surface);
        throw new HttpError(404, 'not found', 'no_route');
      }
      return await storyCall(call, storyMatch, scope);
    } catch (caught) {
      const err = caught as Error & { status?: number };
      // an HttpError carries its status; so does a BoardError, the board's own refusal (foundation/src/errors.ts)
      const status =
        (caught instanceof HttpError || caught instanceof BoardError
          ? caught.status
          : err.status) || 500;
      if (status === 500) {
        log(err.stack || String(err));
      }
      if (!res.headersSent) {
        // a 413's body may still be arriving: close once the answer is out rather than read the rest
        const extra: Record<string, string> = status === 413 ? { Connection: 'close' } : {};
        const code =
          caught instanceof HttpError && caught.code ? caught.code : codeOfStatus(status);
        send(status, { error: err.message || String(err), code }, undefined, extra);
      }
    }
  });
  // which process is the bridge, and on which port, for `once-upon local` (bridge-file.ts)
  server.once('listening', () => {
    announceBridge(home, portOf(), token);
    bridgeListening(); // the capture advertises itself to reports only now that the port is ours
  });
  server.once('close', () => {
    retireBridge(home);
    app.usage.flush();
    unhookUsage();
  });
  return Object.assign(server, {
    stories,
    inbox,
    builds: app.builds,
    board,
    autoReview: app.autoReview,
    usage: app.usage,
  });
}
