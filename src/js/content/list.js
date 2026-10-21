/*
 * PR lists (a repo's /pulls, the global /pulls, and PR search results): one
 * story tag after each PR's title, and the tag is the control (tag.js): Story
 * opens Files changed, Build story or Update asks for one, Queued and
 * Building… show progress. Whether a session is listening is said once for
 * the page, per repo, by the notice (notice.js). One batched bridge call per
 * page. The tags are our own elements in their own shadow roots; nothing of
 * GitHub's is clicked.
 */
import { tagFor, tagHtml, requestFor, missingListeners, TAG_CSS } from './tag.js';
import { listenNotice } from './notice.js';

const ATTR = 'data-dsm-badge';
const PR_HREF = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const alive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

async function bridge(method, path, body) {
  if (!alive()) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
  try {
    return (
      (await chrome.runtime.sendMessage({ type: 'bridge', method, path, body })) || {
        ok: false,
        status: 0,
      }
    );
  } catch (e) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
}

export function isListPage(loc = location) {
  if (/^\/[^/]+\/[^/]+\/pulls\/?$/.test(loc.pathname) || /^\/pulls\/?$/.test(loc.pathname)) {
    return true;
  }
  if (/^\/search\/?$/.test(loc.pathname)) {
    return (
      /^(pullrequests|issues)$/i.test(new URLSearchParams(loc.search).get('type') || '') ||
      /\bis:pr\b/.test(new URLSearchParams(loc.search).get('q') || '')
    );
  }
  if (/^\/[^/]+\/[^/]+\/issues\/?$/.test(loc.pathname)) {
    return /\bis:pr\b/.test(new URLSearchParams(loc.search).get('q') || '');
  }
  return false;
}

/** Title links to PRs on the page, one per row: [{a, row, repo, number}] */
function prLinks() {
  const out = [];
  const rows = new Set();
  for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
    if (a.closest(`[${ATTR}]`)) {
      continue;
    }
    const m = PR_HREF.exec(new URL(a.href, location.origin).pathname);
    if (!m || new URL(a.href, location.origin).origin !== location.origin) {
      continue;
    }
    const text = (a.textContent || '').trim();
    if (!text || /^#\d+$/.test(text)) {
      continue;
    } // "#123" references, not titles
    // the PR's title link, as classic lists, the new React lists and search results mark it
    const title =
      a.matches(
        '[data-hovercard-type="pull_request"], .js-navigation-open, [data-testid*="title" i], h3 a, [id^="issue_"] a.Link--primary',
      ) || !!a.closest('[data-testid*="title" i], h3, h4');
    if (!title) {
      continue;
    }
    const row =
      a.closest('.js-issue-row, [role="listitem"], li, [data-testid*="row" i], tr, article') ||
      a.parentElement;
    if (rows.has(row)) {
      continue;
    }
    rows.add(row);
    out.push({ a, row, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
  }
  return out;
}

const results = new Map(); // "owner/repo#n" -> {state, story, request}
let listening = {}; // repo -> {ok, prompt, details, checkout}, from status-many
const notice = listenNotice();
const keyOf = (repo, number) => `${repo}#${number}`.toLowerCase();

function badgeFor(item) {
  let host = item.row.querySelector(`[${ATTR}="${keyOf(item.repo, item.number)}"]`);
  if (!host) {
    host = document.createElement('span');
    host.setAttribute(ATTR, keyOf(item.repo, item.number));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${TAG_CSS}</style><span class="slot"></span>`;
    shadow.addEventListener('click', (e) => onClick(e, item));
    for (const t of ['keydown', 'keypress', 'keyup']) {
      shadow.addEventListener(t, (e) => e.stopPropagation());
    }
    item.a.after(host);
  }
  return host;
}

function render(item) {
  const r = results.get(keyOf(item.repo, item.number));
  if (!r) {
    return;
  }
  const slot = badgeFor(item).shadowRoot.querySelector('.slot');
  const html = tagHtml(tagFor(r, item));
  if (slot.innerHTML !== html) {
    slot.innerHTML = html;
  }
}

async function onClick(e, item) {
  const target = e.composedPath()[0];
  const b = target.closest && target.closest('button[data-act]');
  if (!b) {
    return;
  } // the Story link is a plain link
  e.preventDefault();
  e.stopPropagation();
  b.disabled = true;
  const t = tagFor(results.get(keyOf(item.repo, item.number)), item);
  const r = await bridge(
    'POST',
    '/api/builds',
    requestFor(t, item, { retell: b.getAttribute('data-act') === 'retell' }),
  );
  if (r.ok) {
    const prev = results.get(keyOf(item.repo, item.number)) || {};
    results.set(
      keyOf(item.repo, item.number),
      t.act === 'update'
        ? { ...prev, updating: true, update_state: r.body.state, request: r.body.request }
        : { state: r.body.state, request: r.body.request },
    );
  } else {
    b.disabled = false;
  }
  render(item);
}

let scanning = false;
let lastAsk = 0;
async function scan(force) {
  if (scanning || !alive() || !isListPage()) {
    return;
  }
  scanning = true;
  try {
    const items = prLinks();
    const need = items.filter((i) => force || !results.has(keyOf(i.repo, i.number)));
    if (need.length) {
      const r = await bridge('POST', '/api/stories/status-many', {
        prs: need.slice(0, 200).map((i) => ({ repo: i.repo, number: i.number })),
      });
      if (!r.ok) {
        return;
      } // no bridge, no badges: the list stays as GitHub draws it
      for (const x of r.body.results) {
        results.set(keyOf(x.repo, x.number), x);
      }
      if (r.body.listening) {
        listening = { ...listening, ...r.body.listening };
      }
      lastAsk = Date.now();
    }
    for (const i of items) {
      render(i);
    }
    const onPage = new Set(items.map((i) => i.repo.toLowerCase()));
    notice.set(
      missingListeners(
        Object.fromEntries(
          Object.entries(listening).filter(([repo]) => onPage.has(repo.toLowerCase())),
        ),
      ),
    );
  } finally {
    scanning = false;
  }
}

const inFlight = (r) => r.state === 'queued' || r.state === 'building' || !!r.updating;

export function initList() {
  let lastHref = location.href;
  let pending = 0;
  // GitHub (and Refined GitHub) redraw list rows; put badges back after any change, debounced
  const observer = new MutationObserver((muts) => {
    if (
      muts.every(
        (m) => m.target.nodeType === 1 && m.target.closest && m.target.closest(`[${ATTR}]`),
      )
    ) {
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = 0;
        scan(false);
      }, 300);
    }
  });
  const start = () => {
    if (isListPage()) {
      observer.observe(document.body, { childList: true, subtree: true });
      scan(false);
    } else {
      observer.disconnect();
      notice.remove();
    }
  };
  setInterval(() => {
    if (!alive()) {
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      start();
    }
    // while something is queued or building, look again every 15s
    else if (isListPage() && [...results.values()].some(inFlight) && Date.now() - lastAsk > 15000) {
      for (const [k, v] of results) {
        if (inFlight(v)) {
          results.delete(k);
        }
      }
      scan(false);
    }
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isListPage()) {
      results.clear();
      scan(true);
    }
  });
  start();
}
