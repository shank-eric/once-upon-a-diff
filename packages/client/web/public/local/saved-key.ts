/*
 * The key a page remembers, so a link with no key in it still opens. `once-upon page` opens the keyed link and prints the keyless
 * one (what lands in a session's report); the page saves the key from its fragment here and takes it out of the address bar.
 * localStorage is per origin (scheme, host and port), so another dev server on 127.0.0.1 cannot read it. A key the bridge
 * refuses (the token was rotated) is forgotten, and the page says to run the command again.
 */

const NAME = (scope: string) => `ou-key:${scope}`;

/** The key saved for a page ('board', or a story's id), or '' when there is none or the browser keeps nothing. */
export function savedKey(scope: string): string {
  try {
    return localStorage.getItem(NAME(scope)) || '';
  } catch {
    return '';
  }
}

/** Saves the key for a page; true only when it reads back, so a browser that keeps nothing leaves the address bar alone. */
export function saveKey(scope: string, key: string): boolean {
  try {
    localStorage.setItem(NAME(scope), key);
    return localStorage.getItem(NAME(scope)) === key;
  } catch {
    return false;
  }
}

/** Forgets the key saved for a page. */
export function forgetKey(scope: string): void {
  try {
    localStorage.removeItem(NAME(scope));
  } catch {
    /* nothing kept */
  }
}

/** The fragment without its key (the repo and session filters stay), as a hash like `#repo=a%2Fb` or ''. */
export function hashWithoutKey(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  params.delete('key');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

/** Takes the key out of the address bar (the rest of the address and the other fragment parts stay). */
export function dropKeyFromAddress(): void {
  if (typeof history !== 'undefined') {
    history.replaceState(null, '', location.pathname + location.search + hashWithoutKey());
  }
}
