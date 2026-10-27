/**
 * The local page's key: a token for one story, made from the bridge's token, so the page never holds the bridge's
 * own. It rides in the page link's #fragment (`once-upon local` and `once-upon page` print it), which the browser
 * never sends to the bridge, so GET /local/<id>/ hands out nothing. The bridge takes it only on that story's
 * /api/stories/<id>/... routes, and only for a local story (index.ts).
 *
 * A story has two keys, and links only step down in power. `pageKey` is the full one: it reads, asks, takes notes and
 * can push the branch for Create pull request. `viewKey` is the read-only one: the same story under its own label, so
 * it can't be turned into the full key, and the PR routes refuse it. The inbox hands out only the read-only one.
 */
import { createHmac } from 'node:crypto';

/** What every page key starts with, so the bridge can tell a wrong key from a wrong token. */
export const PAGE_KEY_PREFIX = 'page.';

/** The page key for one story: an HMAC of its id under the bridge's token. */
export const pageKey = (token: string, story: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update(`local-page:${story}`).digest('base64url');

/**
 * The read-only key for one story: reads, Ask, viewed marks and Fix before push notes (Send too), and nothing else
 * (`viewKeyMay`), so nothing that writes to GitHub or the branch's remote. Made under its own label, so the full key
 * can't be got from it. What the review inbox's links carry.
 */
export const viewKey = (token: string, story: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update(`local-view:${story}`).digest('base64url');

/**
 * What the read-only key may reach on its story, by the route's `what` ('' is the story itself) and the methods allowed.
 * A list of what is allowed, so a route added later is refused to inbox links until someone adds it here:
 *  - reading the story and its page state: the story, version, pulse, freshness, status, working, prefs, ui, seen,
 *    position, read marks and the drafted comments with their marks and Add to fix before push
 *  - Ask: questions
 *  - Viewed marks: viewed
 *  - Fix before push: notes, and fixes (the notes' state, Auto-send, Send, Take back)
 *  - where the branch's PR stands: GET pr, never the POST that pushes
 * Refused: everything else (rebuild, pr writes, and any route not listed).
 */
const VIEW_KEY_MAY: Record<string, readonly string[]> = {
  '': ['GET'],
  version: ['GET'],
  pulse: ['GET'],
  freshness: ['GET'],
  status: ['GET'],
  working: ['GET'],
  prefs: ['GET', 'POST'],
  ui: ['GET', 'POST'],
  seen: ['POST'],
  position: ['POST'],
  read: ['GET', 'POST'],
  drafts: ['GET', 'POST'],
  questions: ['GET', 'POST'],
  viewed: ['POST'],
  notes: ['POST'],
  fixes: ['GET', 'POST'],
  pr: ['GET'],
};

/** Whether the read-only key may make this call on its story (`what` is the route's, '' for the story itself). */
export const viewKeyMay = (what: string, method: string): boolean =>
  Object.hasOwn(VIEW_KEY_MAY, what) && VIEW_KEY_MAY[what].includes(method);

/**
 * The review inbox page's key: a token for the inbox page, which reaches the inbox routes (routes/inbox.ts) that
 * allow it and nothing else. Made like a story's, under its own label so no story's key can stand in for it.
 */
export const inboxKey = (token: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update('inbox-page').digest('base64url');

/**
 * The agent board page's key: a token for the board page, which reaches the board routes (routes/board.ts) that allow
 * it and nothing else. Made under its own label, so neither the inbox's key nor a story's can stand in for it.
 */
export const boardKey = (token: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update('board-page').digest('base64url');

/** The agent board page's link, with its key in the fragment. */
export const boardPageUrl = (
  port: number,
  token: string,
  origin = `http://127.0.0.1:${port}`,
): string => `${origin}/board/#key=${boardKey(token)}`;

/**
 * The review inbox page's link, with its key in the fragment, and the repo to show (owner/name) when there is one.
 */
export const inboxPageUrl = (
  port: number,
  token: string,
  repo: string | null = null,
  origin = `http://127.0.0.1:${port}`,
): string =>
  `${origin}/inbox/#key=${inboxKey(token)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;

/** The local page's link, with its key in the fragment: the full key, or the read-only one when `readOnly`. */
export const localPageUrl = (
  port: number,
  story: string,
  token: string,
  readOnly = false,
): string =>
  `http://127.0.0.1:${port}/local/${encodeURIComponent(story)}/#key=${(readOnly ? viewKey : pageKey)(token, story)}`;
