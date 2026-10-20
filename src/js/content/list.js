/*
 * PR lists (a repo's /pulls, the global /pulls, and PR search results): a
 * small badge after each PR's title saying whether it has a story. "Story"
 * opens the PR's Files changed tab, where the panel docks; "Building…" means
 * one was asked for; "Build story" asks for one (the same build request as
 * the PR page's button). One batched bridge call per page. The badges are our
 * own buttons in their own shadow roots; nothing of GitHub's is clicked.
 */
const ATTR = 'data-dsm-badge';
const PR_HREF = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const alive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

async function bridge(method, path, body) {
  if (!alive()) return { ok: false, status: 0, error: 'extension reloaded' };
  try { return (await chrome.runtime.sendMessage({ type: 'bridge', method, path, body })) || { ok: false, status: 0 }; } catch (e) { return { ok: false, status: 0, error: 'extension reloaded' }; }
}

export function isListPage(loc = location) {
  if (/^\/[^/]+\/[^/]+\/pulls\/?$/.test(loc.pathname) || /^\/pulls\/?$/.test(loc.pathname)) return true;
  if (/^\/search\/?$/.test(loc.pathname)) return /^(pullrequests|issues)$/i.test(new URLSearchParams(loc.search).get('type') || '') || /\bis:pr\b/.test(new URLSearchParams(loc.search).get('q') || '');
  if (/^\/[^/]+\/[^/]+\/issues\/?$/.test(loc.pathname)) return /\bis:pr\b/.test(new URLSearchParams(loc.search).get('q') || '');
  return false;
}

const CSS = `
  :host { all: initial; display: inline-block; vertical-align: middle; margin-left: 6px; }
  .b { font: 500 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; display: inline-flex; align-items: center; gap: 4px;
    padding: 0 7px; border-radius: 999px; border: 1px solid var(--borderColor-default, #d1d9e0); color: var(--fgColor-muted, #59636e);
    background: var(--bgColor-default, #fff); cursor: pointer; text-decoration: none; white-space: nowrap; }
  .b:hover { color: var(--fgColor-accent, #0969da); border-color: var(--fgColor-accent, #0969da); }
  .b.ready { color: var(--fgColor-success, #1a7f37); border-color: var(--fgColor-success, #1a7f37); }
  .b.building { cursor: default; }
  .b.building:hover { color: var(--fgColor-muted, #59636e); border-color: var(--borderColor-default, #d1d9e0); }
  .spin { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; border-top-color: transparent; animation: s .9s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

/** Title links to PRs on the page, one per row: [{a, row, repo, number}] */
function prLinks() {
  const out = [];
  const rows = new Set();
  for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
    if (a.closest(`[${ATTR}]`)) continue;
    const m = PR_HREF.exec(new URL(a.href, location.origin).pathname);
    if (!m || new URL(a.href, location.origin).origin !== location.origin) continue;
    const text = (a.textContent || '').trim();
    if (!text || /^#\d+$/.test(text)) continue; // "#123" references, not titles
    // the PR's title link, as classic lists, the new React lists and search results mark it
    const title = a.matches('[data-hovercard-type="pull_request"], .js-navigation-open, [data-testid*="title" i], h3 a, [id^="issue_"] a.Link--primary')
      || !!a.closest('[data-testid*="title" i], h3, h4');
    if (!title) continue;
    const row = a.closest('.js-issue-row, [role="listitem"], li, [data-testid*="row" i], tr, article') || a.parentElement;
    if (rows.has(row)) continue;
    rows.add(row);
    out.push({ a, row, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
  }
  return out;
}

const results = new Map(); // "owner/repo#n" -> {state, story, request}
const keyOf = (repo, number) => `${repo}#${number}`.toLowerCase();

function badgeFor(item) {
  let host = item.row.querySelector(`[${ATTR}="${keyOf(item.repo, item.number)}"]`);
  if (!host) {
    host = document.createElement('span');
    host.setAttribute(ATTR, keyOf(item.repo, item.number));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><span class="slot"></span>`;
    shadow.addEventListener('click', e => onClick(e, item));
    for (const t of ['keydown', 'keypress', 'keyup']) shadow.addEventListener(t, e => e.stopPropagation());
    item.a.after(host);
  }
  return host;
}

function render(item) {
  const r = results.get(keyOf(item.repo, item.number));
  if (!r) return;
  const slot = badgeFor(item).shadowRoot.querySelector('.slot');
  const href = `https://github.com/${item.repo}/pull/${item.number}/changes`;
  if (r.state === 'ready') slot.innerHTML = `<a class="b ready" href="${href}" title="Open the story on Files changed">Story</a>`;
  else if (r.state === 'building') slot.innerHTML = `<span class="b building" title="A story was asked for${r.request && r.request.requested_at ? ` at ${new Date(r.request.requested_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}"><span class="spin"></span>Building…</span>`;
  else slot.innerHTML = `<button class="b" data-act="build" title="Ask a Claude session to write a story for this PR">Build story</button>`;
}

async function onClick(e, item) {
  const b = e.composedPath()[0].closest && e.composedPath()[0].closest('[data-act="build"]');
  if (!b) return; // the Story link is a plain link
  e.preventDefault();
  e.stopPropagation();
  b.disabled = true;
  const r = await bridge('POST', '/api/builds', { repo: item.repo, number: item.number, url: `https://github.com/${item.repo}/pull/${item.number}`, requested_at: new Date().toISOString() });
  if (r.ok) results.set(keyOf(item.repo, item.number), { state: 'building', request: r.body.request });
  else b.disabled = false;
  render(item);
}

let scanning = false;
let lastAsk = 0;
async function scan(force) {
  if (scanning || !alive() || !isListPage()) return;
  scanning = true;
  try {
    const items = prLinks();
    const need = items.filter(i => force || !results.has(keyOf(i.repo, i.number)));
    if (need.length) {
      const r = await bridge('POST', '/api/stories/status-many', { prs: need.slice(0, 200).map(i => ({ repo: i.repo, number: i.number })) });
      if (!r.ok) return; // no bridge, no badges: the list stays as GitHub draws it
      for (const x of r.body.results) results.set(keyOf(x.repo, x.number), x);
      lastAsk = Date.now();
    }
    for (const i of items) render(i);
  } finally {
    scanning = false;
  }
}

export function initList() {
  let lastHref = location.href;
  let pending = 0;
  // GitHub (and Refined GitHub) redraw list rows; put badges back after any change, debounced
  const observer = new MutationObserver(muts => {
    if (muts.every(m => m.target.nodeType === 1 && m.target.closest && m.target.closest(`[${ATTR}]`))) return;
    if (!pending) pending = setTimeout(() => { pending = 0; scan(false); }, 300);
  });
  const start = () => { if (isListPage()) { observer.observe(document.body, { childList: true, subtree: true }); scan(false); } else observer.disconnect(); };
  setInterval(() => {
    if (!alive()) return;
    if (location.href !== lastHref) { lastHref = location.href; start(); }
    // while something is building, look again every 15s
    else if (isListPage() && [...results.values()].some(r => r.state === 'building') && Date.now() - lastAsk > 15000) {
      for (const [k, v] of results) if (v.state === 'building') results.delete(k);
      scan(false);
    }
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isListPage()) { results.clear(); scan(true); } });
  start();
}
