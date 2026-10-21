/*
 * Hide whitespace on GitHub PR pages, remembered across PRs, reloads and
 * restarts. It's the same setting as the local page's Hide whitespace: the
 * bridge keeps it in prefs.json (GET/POST /api/prefs), and chrome.storage
 * holds a copy for when the bridge is down.
 *
 * GitHub's own setting lives in the URL (?w=1). So:
 *   - arriving on a PR's Files changed page without w, with the setting on,
 *     reloads it once with ?w=1
 *   - a URL that says w=1 or w=0 is the reviewer's choice (GitHub's toggle, or a link),
 *     and becomes the setting
 *   - w=1 dropping off the same page means GitHub's toggle was turned off
 *
 * No chrome.* or DOM here, so the rules can be tested in node.
 */
import { filesChangedPr } from '../shared/util/github-paths.js';

export const REDIRECT_GUARD_MS = 15000;

/** {key, view} for a PR's Files changed page (view is 'changes' or 'files'), else null. */
export function filesPage(href) {
  const pr = filesChangedPr(new URL(href).pathname);
  return pr ? { key: pr.key, view: pr.view } : null;
}

/** true for ?w=1, false for ?w=0, null when the URL doesn't say. */
export function wOf(href) {
  const v = new URL(href).searchParams.get('w');
  if (v === null) {
    return null;
  }
  return v === '1' || v === 'true';
}

/** The same URL (hash kept) with ?w=1, or without w. */
export function withW(href, on) {
  const u = new URL(href);
  if (on) {
    u.searchParams.set('w', '1');
  } else {
    u.searchParams.delete('w');
  }
  return u.toString();
}

/** What this tab last saw, kept in sessionStorage so it outlives a full reload. */
export const seen = (href) => {
  const page = filesPage(href);
  return page ? { ...page, w: wOf(href) } : { key: null };
};

/**
 * What to do on a page.
 * @param {{href: string, prev: object|null, pref: boolean, redirect: {from: string, at: number}|null, now?: number}} o
 *   prev is `seen()` of the page before this one in the same tab; redirect is our last ?w=1 reload.
 * @returns {{action: 'none'} | {action: 'save', value: boolean} | {action: 'redirect', url: string}}
 */
export function decide({ href, prev, pref, redirect, now = Date.now() }) {
  const page = filesPage(href);
  if (!page) {
    return { action: 'none' };
  }
  const w = wOf(href);
  if (w !== null) {
    return w === pref ? { action: 'none' } : { action: 'save', value: w };
  }
  // the URL doesn't say. On the same page that just had w=1, GitHub's toggle was turned off.
  const samePage = !!prev && prev.key === page.key && prev.view === page.view;
  if (samePage && prev.w === true) {
    return pref ? { action: 'save', value: false } : { action: 'none' };
  }
  if (!pref) {
    return { action: 'none' };
  }
  // we already reloaded this URL with w=1 and came back without it: GitHub dropped it, so don't loop
  if (redirect && redirect.from === href && now - redirect.at < REDIRECT_GUARD_MS) {
    return { action: 'none' };
  }
  return { action: 'redirect', url: withW(href, true) };
}

/**
 * The setting, from the bridge when it answers, else the chrome.storage copy.
 * A change made while the bridge was down is marked dirty and sent once it's back.
 * @param {{call: (method: string, path: string, body?: object) => Promise<{ok: boolean, body: any}>,
 *          load: () => Promise<object|null>, store: (v: object) => Promise<void>}} io
 */
export function prefsStore({ call, load, store }) {
  return {
    async read() {
      const copy = (await load()) || {};
      const r = await call('GET', '/api/prefs');
      if (!r.ok) {
        return !!copy.hideWhitespace;
      }
      if (copy.dirty && !!copy.hideWhitespace !== !!r.body.hideWhitespace) {
        const w = await call('POST', '/api/prefs', { hideWhitespace: !!copy.hideWhitespace });
        if (w.ok) {
          await store({ hideWhitespace: !!w.body.hideWhitespace });
          return !!w.body.hideWhitespace;
        }
        return !!copy.hideWhitespace;
      }
      await store({ hideWhitespace: !!r.body.hideWhitespace });
      return !!r.body.hideWhitespace;
    },
    async write(on) {
      const r = await call('POST', '/api/prefs', { hideWhitespace: !!on });
      await store(
        r.ok ? { hideWhitespace: !!r.body.hideWhitespace } : { hideWhitespace: !!on, dirty: true },
      );
      return r.ok;
    },
  };
}
