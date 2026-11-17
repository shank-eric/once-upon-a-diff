/*
 * How the board page authenticates. A link carries the page key in its #fragment. On a name a proxy forwards
 * (https://once-upon.test), the page hands it to /auth/session once, the server sets an HttpOnly cookie for that host, and the
 * page drops the key from the address bar, so the URL is just /board/ and later visits need no key. See
 * src/server/session-cookie.ts. On the bridge's own address (no cookie) the page sends the key as a header on every call, saves
 * it (saved-key.ts) and drops it from the address bar, so a later visit to the keyless link finds it.
 */
import { dropKeyFromAddress, forgetKey, saveKey, savedKey } from './saved-key.ts';

let cookie = false;
/** The key the page sends as a header: the link's, else the one saved by an earlier visit. */
let key = '';
/** The key came from storage and not from this link, so a refusal means it is stale. */
let fromStorage = false;

/**
 * Call once at load with the key from the fragment ('' when there is none) and a cheap route the page's key may call
 * (`probe`). With a key, a host that takes cookies keeps it there: the server says it set the cookie, and the page drops the
 * key from the address bar and the header only once a call by cookie alone has worked (the key is not also saved, the
 * cookie carries it). A host that refused the cookie (plain http, cookies blocked) saves the key and drops it from the bar once
 * a call with it works.
 * With none, the saved key is used, else the cookie from an earlier visit is relied on.
 */
export async function startAuth(fragmentKey: string, probe: string): Promise<void> {
  key = fragmentKey || savedKey('board');
  fromStorage = !fragmentKey && !!key;
  if (!key) {
    cookie = true;
    return;
  }
  if (fromStorage) {
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
        dropKeyFromAddress();
        return;
      }
    }
  } catch {
    /* no cookie: the key still works as a header */
  }
  // no cookie: the key goes as a header, and is saved only once the bridge takes it, so an old link cannot replace a good one
  try {
    const check = await fetch(probe, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (check.ok && saveKey('board', key)) {
      dropKeyFromAddress();
    }
  } catch {
    /* the bridge did not answer: nothing is saved, and the key stays in the address */
  }
}

/** The header for an API call: the key, unless the cookie carries it. */
export const authHeader = (): Record<string, string> =>
  cookie || !key ? {} : { Authorization: `Bearer ${key}` };

/** A call came back 401: a key kept from an earlier visit is stale (the token changed), so forget it. */
export function keyRefused(): void {
  if (fromStorage) {
    forgetKey('board');
    key = '';
    fromStorage = false;
  }
}
