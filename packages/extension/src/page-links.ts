/*
 * The board page is opened from a link the bridge makes (it carries the page's key). The extension opens
 * only a link of the right shape: the bridge's own 127.0.0.1 address over http, or an https host name (the proxy's, such
 * as once-upon.test), to /board/ with a page key in the fragment. No DOM or chrome APIs, so tests can use it.
 */

export type PageKind = 'board';

const KEY = String.raw`#key=page\.[A-Za-z0-9_-]+`;
const LOOPBACK = String.raw`http:\/\/127\.0\.0\.1:\d{2,5}`;
const NAMED = String.raw`https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*`;

/** Whether `url` is a link to the bridge's board page, with its key. */
export function isPageLink(kind: PageKind, url: unknown): url is string {
  return (
    typeof url === 'string' && new RegExp(`^(?:${LOOPBACK}|${NAMED})\\/${kind}\\/${KEY}$`).test(url)
  );
}
