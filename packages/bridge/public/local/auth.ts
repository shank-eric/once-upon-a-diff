/*
 * How the board page authenticates. A link carries the page key in its #fragment. On the bridge's own address
 * the page sends it as a header on every call. On a name a proxy forwards (https://once-upon.test), the page hands it
 * to /auth/session once, the server sets an HttpOnly cookie for that host, and the page drops the key from the address
 * bar, so the URL is just /board/ and later visits need no key. See src/server/session-cookie.ts.
 */

let cookie = false;

/** The fragment without its key (the repo and session filters stay), as a hash like `#repo=a%2Fb` or ''. */
function hashWithoutKey(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  params.delete('key');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

/**
 * Call once at load with the key from the fragment ('' when there is none) and a cheap route the page's key may call
 * (`probe`). Without a key the cookie from an earlier visit is relied on. With one, a host that takes cookies keeps
 * it: the server says it set the cookie, and the page drops the key from the address bar and the header only once a
 * call by cookie alone has worked. A browser that refused the cookie (plain http, cookies blocked) keeps the key.
 */
export async function startAuth(key: string, probe: string): Promise<void> {
  if (!key) {
    cookie = true;
    return;
  }
  try {
    const response = await fetch('/auth/session', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const answer: { cookie?: boolean } = await response.json().catch(() => ({}));
    if (response.ok && answer.cookie) {
      const check = await fetch(probe, { cache: 'no-store' });
      if (check.ok) {
        cookie = true;
        history.replaceState(null, '', location.pathname + location.search + hashWithoutKey());
      }
    }
  } catch {
    /* no cookie: the key in the fragment still works as a header */
  }
}

/** The header for an API call: the key, unless the cookie carries it. */
export const authHeader = (key: string): Record<string, string> =>
  cookie || !key ? {} : { Authorization: `Bearer ${key}` };
