/**
 * The local page's key: a token for one story, made from the bridge's token, so the page never holds the bridge's
 * own. It rides in the page link's #fragment (`once-upon local` and `once-upon page` print it), which the browser
 * never sends to the bridge, so GET /local/<id>/ hands out nothing. The bridge takes it only on that story's
 * /api/stories/<id>/... routes, and only for a local story (index.ts).
 */
import { createHmac } from 'node:crypto';

/** What every page key starts with, so the bridge can tell a wrong key from a wrong token. */
export const PAGE_KEY_PREFIX = 'page.';

/** The page key for one story: an HMAC of its id under the bridge's token. */
export const pageKey = (token: string, story: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update(`local-page:${story}`).digest('base64url');

/**
 * The review inbox page's key: a token for the inbox page, which reaches the inbox routes (routes/inbox.ts) that
 * allow it and nothing else. Made like a story's, under its own label so no story's key can stand in for it.
 */
export const inboxKey = (token: string): string =>
  PAGE_KEY_PREFIX + createHmac('sha256', token).update('inbox-page').digest('base64url');

/** The review inbox page's link, with its key in the fragment, and the repo to show (owner/name) when there is one. */
export const inboxPageUrl = (port: number, token: string, repo: string | null = null): string =>
  `http://127.0.0.1:${port}/inbox/#key=${inboxKey(token)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;

/** The local page's link, with its key in the fragment. */
export const localPageUrl = (port: number, story: string, token: string): string =>
  `http://127.0.0.1:${port}/local/${encodeURIComponent(story)}/#key=${pageKey(token, story)}`;
