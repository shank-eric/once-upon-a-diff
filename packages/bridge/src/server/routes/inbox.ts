/*
 * The review inbox: the page (public/inbox.ts) lists what waits for review and the extension and the CLI open it.
 *
 *   GET  /api/inbox        what waits for review, and each repo's counts
 *   GET  /api/inbox/link   the inbox page's link (?repo= filters it), for the extension and the CLI
 *
 * The link needs the bridge's token. The list also takes the inbox page's key (page-key.ts), which reaches
 * the routes that allow it (`inboxKey`) and nothing else.
 */
import { REPO_RE } from '../../config/repos.ts';
import type { InboxList } from '@once-upon-a-diff/shared/types';
import type { ApiRoute, Call } from '../../types.ts';

/** Nothing is listed yet: the stories the inbox lists come with later changes. */
function list({ send }: Call) {
  const empty: InboxList = { repos: [] };
  return send(200, empty);
}

function link({ app, url, send }: Call) {
  const repo = url.searchParams.get('repo');
  return send(200, { url: app.links.inbox(repo && REPO_RE.test(repo) ? repo : null) });
}

export const inboxRoutes: ApiRoute[] = [
  { path: '/api/inbox', method: 'GET', handle: list, inboxKey: true },
  { path: '/api/inbox/link', method: 'GET', handle: link },
];
