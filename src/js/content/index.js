/*
 * On a GitHub PR's /changes or /files page, asks the bridge (through the
 * service worker) whether there's a story for this PR and, if so, docks the
 * story panel. It re-applies the panel after a reload, after GitHub's in-page
 * navigation, and when the story on disk changes, starting from the step
 * saved for this PR.
 *
 * It never clicks GitHub's controls, never submits GitHub's forms and makes no
 * network calls of its own: everything goes through the service worker to the
 * bridge on 127.0.0.1.
 */
import { storyOverlay } from '../shared/overlay.js';

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(changes|files)(?:\/|$)/;
const PANEL_ID = 'diff-story-panel';
const alive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

async function bridge(method, path, body) {
  if (!alive()) return { ok: false, status: 0, error: 'extension reloaded' };
  try {
    return (await chrome.runtime.sendMessage({ type: 'bridge', method, path, body })) || { ok: false, status: 0, error: 'no answer' };
  } catch (e) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
}

// ---------- saved panel state per PR: {n, all, collapsed, width, hidden}
const uiKey = key => `ui:${key}`;
async function loadUi(key) {
  if (!alive()) return {};
  try { return (await chrome.storage.local.get(uiKey(key)))[uiKey(key)] || {}; } catch (e) { return {}; }
}
async function saveUi(key, ui) {
  if (!alive()) return;
  try { await chrome.storage.local.set({ [uiKey(key)]: ui }); } catch (e) { /* extension reloaded */ }
}

// ---------- one PR page at a time
let cur = null; // {key, owner, repo, number, id, version, data, ui, overlay, status}
let syncing = false;

function prOfLocation() {
  const m = PR_PATH.exec(location.pathname);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() } : null;
}

function unmount() {
  if (cur && cur.overlay) cur.overlay.destroy();
  if (cur) cur.overlay = null;
}

function mount() {
  if (!cur || !cur.data || cur.ui.hidden) return;
  const { key } = cur;
  const storyPath = `/api/stories/${encodeURIComponent(cur.id)}`;
  if (cur.overlay) cur.overlay.destroy();
  cur.overlay = storyOverlay(cur.data, {
    initial: cur.ui,
    host: 'GitHub',
    onState: s => {
      if (!cur || cur.key !== key) return;
      cur.ui = { ...s, hidden: false };
      saveUi(key, cur.ui);
    },
    onPosition: p => bridge('POST', `${storyPath}/position`, { ...p, url: location.href }),
    onClose: () => {
      if (!cur || cur.key !== key) return;
      cur.overlay = null;
      cur.ui = { ...cur.ui, hidden: true };
      saveUi(key, cur.ui);
      toast('Story hidden. Click the Diff Story Mode toolbar button (or Alt+Shift+S) to bring it back.');
    },
    ask: async q => {
      const r = await bridge('POST', `${storyPath}/questions`, { ...q, url: location.href });
      if (!r.ok) throw new Error(r.error === 'unreachable' ? 'the bridge is not running' : r.error);
      return r.body;
    },
    loadQuestions: async () => {
      const r = await bridge('GET', `${storyPath}/questions`);
      if (!r.ok) throw new Error(r.error);
      return r.body.questions;
    },
  });
}

async function fetchStory(id) {
  const r = await bridge('GET', `/api/stories/${encodeURIComponent(id)}`);
  return r.ok ? r.body : null;
}

/** Bring the page in line with the URL: mount, keep, or remove the panel. */
async function sync() {
  if (syncing || !alive()) return;
  syncing = true;
  try {
    const pr = prOfLocation();
    if (!pr) { unmount(); cur = null; return; }
    if (cur && cur.key === pr.key) {
      // GitHub can swap out <body> on in-page navigation, which takes the panel with it
      if (cur.data && !cur.ui.hidden && (!cur.overlay || !document.getElementById(PANEL_ID))) mount();
      return;
    }
    unmount();
    cur = { ...pr, id: null, version: null, data: null, ui: {}, overlay: null, status: 'loading' };
    const mine = cur;
    const found = await bridge('GET', `/api/stories/find?repo=${encodeURIComponent(`${pr.owner}/${pr.repo}`)}&number=${pr.number}`);
    if (cur !== mine) return;
    if (!found.ok) { cur.status = found.error || `HTTP ${found.status}`; return; }
    const data = await fetchStory(found.body.id);
    if (cur !== mine || !data) return;
    cur.id = found.body.id;
    cur.version = data.version;
    cur.data = data;
    cur.ui = await loadUi(pr.key);
    cur.status = 'ready';
    mount();
  } finally {
    syncing = false;
  }
}

/** When chapters.json changes on disk (Claude filled in a chapter), redraw in place. */
let lastRetry = 0;
async function checkForUpdates() {
  if (!cur || document.visibilityState !== 'visible') return;
  if (!cur.id) {
    // no story yet, or no bridge yet: look again every 10s, since a story can be published while the page is open
    if (cur.status !== 'loading' && cur.status !== 'not-configured' && Date.now() - lastRetry > 10000) {
      lastRetry = Date.now();
      cur = null;
      sync();
    }
    return;
  }
  const r = await bridge('GET', `/api/stories/${encodeURIComponent(cur.id)}/version`);
  if (!r.ok || !cur || r.body.version === cur.version) return;
  const mine = cur;
  const data = await fetchStory(cur.id);
  if (cur !== mine || !data) return;
  cur.data = data;
  cur.version = data.version;
  if (cur.overlay) {
    cur.ui = { ...cur.overlay.state, hidden: false };
    mount();
  }
}

async function toggle() {
  const pr = prOfLocation();
  if (!pr) return toast('Diff Story Mode works on a pull request\'s Files changed page.');
  if (!cur || cur.key !== pr.key || !cur.data) {
    await sync();
    if (!cur || !cur.data) {
      const why = !cur ? '' : cur.status === 'not-configured' ? 'Set the bridge port and token in the extension options first.'
        : cur.status === 'unreachable' ? 'The bridge isn\'t running. Start it with: diff-story serve'
          : /HTTP 401|token/.test(cur.status) ? 'The bridge rejected the token. Copy it again from: diff-story setup'
            : 'The bridge has no story for this PR.';
      return toast(why || 'No story for this PR.');
    }
  }
  if (cur.overlay && document.getElementById(PANEL_ID)) {
    cur.ui = { ...cur.overlay.state, hidden: true };
    unmount();
  } else {
    cur.ui = { ...cur.ui, hidden: false };
    mount();
  }
  saveUi(cur.key, cur.ui);
}

function toast(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100;max-width:360px;padding:8px 12px;border-radius:6px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    + 'background:var(--bgColor-emphasis,#25292e);color:var(--fgColor-onEmphasis,#fff);box-shadow:0 4px 12px rgba(0,0,0,.2)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

if (alive()) {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'toggle') toggle();
  });
}

// GitHub navigates without reloading (Turbo and React routes), so watch the URL as well as the usual events
let lastHref = '';
setInterval(() => {
  if (!alive()) return;
  if (location.href !== lastHref) { lastHref = location.href; sync(); }
  else if (cur && cur.data && !cur.ui.hidden && !document.getElementById(PANEL_ID)) sync();
}, 700);
for (const ev of ['turbo:load', 'turbo:render', 'popstate', 'pageshow']) window.addEventListener(ev, () => sync());
setInterval(() => { if (alive()) checkForUpdates(); }, 5000);
lastHref = location.href;
sync();
