/**
 * The page key in a cookie, for the pages served on an allowed host name (a reverse proxy such as puma-dev, over https).
 * A link carries the key in its #fragment, which the server never sees, so the page posts it to /auth/session once, the
 * server checks it and sets a cookie for that host, and the page drops the fragment: later visits are just
 * https://once-upon.test/board/. The inbox and the board keep their own cookies, and each is the same page key the
 * fragment would have carried, so the key checks on the API are the same either way.
 *
 * `__Host-` makes the browser require Secure, Path=/ and no Domain, so the cookie belongs to that one host. HttpOnly keeps
 * the page's script from reading it; SameSite=Strict keeps other sites from sending it. A request authenticated by
 * cookie alone must also carry an allowed Origin if it writes (index.ts).
 */
import type { IncomingMessage } from 'node:http';

export const COOKIE_NAMES = { inbox: '__Host-ou-inbox', board: '__Host-ou-board' } as const;
const MAX_AGE_S = 30 * 24 * 3600;

/** The request's cookies, by name. */
export function cookiesOf(req: IncomingMessage): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0) {
      jar[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
    }
  }
  return jar;
}

/** A Set-Cookie value that keeps the key for the host. */
export const cookieFor = (name: string, key: string): string =>
  `${name}=${key}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
