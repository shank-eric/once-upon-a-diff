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
import { statusControl } from './status.js';
import { initList } from './list.js';
import { initConversation } from './convo.js';
import { decide, filesPage, seen, prefsStore } from './whitespace.js';

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
  const storyId = cur.id;
  const storyPath = `/api/stories/${encodeURIComponent(storyId)}`;
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
      refreshStatus();
      toast('Story hidden. Click the Diff Story Mode toolbar button (or Alt+Shift+S) to bring it back.');
    },
    ask: async q => {
      const r = await bridge('POST', `${storyPath}/questions`, { ...q, url: location.href });
      if (!r.ok) throw new Error(r.error === 'unreachable' ? 'the bridge is not running' : r.error);
      return r.body;
    },
    drafts: {
      load: async () => { const r = await bridge('GET', `${storyPath}/drafts`); if (!r.ok) throw new Error(r.error); return r.body; },
      act: async (chapter, index, action) => { const r = await bridge('POST', `${storyPath}/drafts`, { chapter, index, action }); if (!r.ok) throw new Error(r.error); return r.body; },
    },
    freshness: async () => { const r = await bridge('GET', `${storyPath}/freshness`); if (!r.ok) throw new Error(r.error); return r.body; },
    requestUpdate: async (base) => {
      const pr = prOfLocation();
      const r = await bridge('POST', '/api/builds', { repo: `${pr.owner}/${pr.repo}`, number: pr.number, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, requested_at: new Date().toISOString(), mode: 'update', base_sha: base });
      if (!r.ok) throw new Error(r.error);
      return r.body;
    },
    status: async () => {
      const r = await bridge('GET', `/api/status?story=${encodeURIComponent(storyId)}`);
      if (r.ok) return r.body;
      throw Object.assign(new Error(r.error), { code: r.status === 401 ? 'token' : r.status === 404 ? 'old' : 'down' });
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
    const q = `repo=${encodeURIComponent(`${pr.owner}/${pr.repo}`)}&number=${pr.number}`;
    const found = await bridge('GET', `/api/stories/find?${q}`);
    if (cur !== mine) return;
    if (!found.ok && found.status === 404) {
      // no story: is one being built?
      const st = await bridge('GET', `/api/builds/status?${q}`);
      if (cur !== mine) return;
      cur.build = st.ok ? st.body.request : null;
      // is a session listening for this repo to build it? (the status light's check, per repo)
      const ls = await bridge('GET', `/api/status?${q}`);
      if (cur !== mine) return;
      cur.listening = ls.ok ? ls.body.listening : null;
      // queued: asked for, no session has it yet. building: a session claimed it.
      cur.status = st.ok && (st.body.state === 'queued' || st.body.state === 'building') ? st.body.state : 'none';
      if (st.ok && st.body.state === 'ready') { cur = null; return; } // it turned up in between; the next tick picks it up
      return;
    }
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
    refreshStatus();
  }
}

// ---------- the status control: story ready / building / build story
const status = statusControl({
  onOpen: () => {
    if (!cur || !cur.data) return;
    cur.ui = { ...cur.ui, hidden: false };
    mount();
    saveUi(cur.key, cur.ui);
    refreshStatus();
  },
  onBuild: () => requestBuild(),
});

function refreshStatus() {
  if (!alive() || !cur || !prOfLocation()) return status.set('hidden');
  if (cur.data) return status.set(cur.overlay && document.getElementById(PANEL_ID) ? 'hidden' : 'ready');
  const l = cur.listening && !cur.listening.ok ? cur.listening : null;
  const prompt = l ? l.prompt : null;
  const more = l ? { details: l.details, repo: l.repo, checkout: l.checkout } : {};
  if (cur.status === 'queued' || cur.status === 'building') return status.set(cur.status, { requested_at: cur.build && cur.build.requested_at, prompt, ...more });
  if (cur.status === 'none') {
    const failed = cur.build && cur.build.status === 'failed' ? 'Last build failed.' : '';
    return status.set('none', { note: failed, prompt, ...more });
  }
  if (cur.status === 'unreachable') return status.set('offline', { note: 'Story bridge offline' });
  if (/HTTP 401|token/.test(cur.status || '')) return status.set('offline', { note: 'Story bridge rejected the token' });
  return status.set('hidden'); // loading, or not set up yet
}

async function requestBuild() {
  const pr = prOfLocation();
  if (!pr || !cur || cur.key !== pr.key) return;
  const mine = cur;
  const r = await bridge('POST', '/api/builds', {
    repo: `${pr.owner}/${pr.repo}`, number: pr.number, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, requested_at: new Date().toISOString(),
  });
  if (cur !== mine) return;
  if (r.ok) { cur.status = r.body.state === 'building' ? 'building' : 'queued'; cur.build = r.body.request; lastRetry = Date.now(); }
  else toast(r.status === 404 ? 'This bridge is older than the Build story button. Restart it: diff-story serve' : `Couldn't ask the bridge: ${r.error}`);
  refreshStatus();
}

/** When chapters.json changes on disk (Claude filled in a chapter), redraw in place. */
let lastRetry = 0;
async function checkForUpdates() {
  if (!cur || document.visibilityState !== 'visible') return;
  if (!cur.id) {
    // poll only while a build is pending (every 10s), or slowly while the bridge is down (every 30s)
    const every = cur.status === 'queued' || cur.status === 'building' ? 10000 : cur.status === 'unreachable' ? 30000 : 0;
    if (every && Date.now() - lastRetry > every) {
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
    cur.ui = { ...cur.overlay.state, hidden: false, bodyScroll: cur.overlay.bodyScroll };
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
  refreshStatus();
}

// ---------- Hide whitespace: GitHub's ?w=1, remembered in the bridge's prefs.json (the local page's setting too)
const prefs = prefsStore({
  call: bridge,
  load: async () => { if (!alive()) return null; try { return (await chrome.storage.local.get('prefs')).prefs || null; } catch (e) { return null; } },
  store: async v => { if (!alive()) return; try { await chrome.storage.local.set({ prefs: v }); } catch (e) { /* extension reloaded */ } },
});
const W_PREV = 'diff-story:w-prev';
const W_REDIRECT = 'diff-story:w-redirect';
const session = {
  get: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
};
async function whitespaceCheck() {
  if (!alive()) return;
  const href = location.href;
  const prev = session.get(W_PREV);
  session.set(W_PREV, seen(href));
  const page = filesPage(href);
  if (!page) return;
  const d = decide({ href, prev, pref: await prefs.read(), redirect: session.get(W_REDIRECT) });
  if (d.action === 'save') return prefs.write(d.value);
  if (d.action !== 'redirect' || location.href !== href) return;
  session.set(W_REDIRECT, { from: href, at: Date.now() });
  // keep the panel's step and scroll across the reload
  if (cur && cur.key === page.key && cur.overlay) {
    cur.ui = { ...cur.overlay.state, hidden: false, bodyScroll: cur.overlay.bodyScroll };
    await saveUi(cur.key, cur.ui);
  }
  location.replace(d.url);
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
  // a tab opened before the port and token were saved looks again as soon as they are
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings && cur && !cur.data) { cur = null; sync(); }
  });
}

// GitHub navigates without reloading (Turbo and React routes), so watch the URL as well as the usual events
let lastHref = '';
setInterval(() => {
  if (!alive()) return;
  if (location.href !== lastHref) { lastHref = location.href; whitespaceCheck().catch(() => {}); sync(); }
  else if (cur && cur.data && !cur.ui.hidden && !document.getElementById(PANEL_ID)) sync();
  else if (cur && !document.getElementById('diff-story-status')) refreshStatus(); // GitHub swapped out <body>
}, 700);
for (const ev of ['turbo:load', 'turbo:render', 'popstate', 'pageshow']) window.addEventListener(ev, () => sync());
// coming back to a tab with no story: look once (another tab may have asked for a build, or the story may be done)
// a comment drafted in the terminal shows up as soon as you come back to the tab
window.addEventListener('focus', () => { if (alive() && cur && cur.id) checkForUpdates(); });
document.addEventListener('visibilitychange', () => {
  if (alive() && document.visibilityState === 'visible' && cur && cur.id) checkForUpdates();
  if (alive() && document.visibilityState === 'visible' && cur && !cur.data && cur.status !== 'loading') { cur = null; sync(); }
});
setInterval(() => { if (alive()) checkForUpdates(); }, 5000);
lastHref = location.href;
whitespaceCheck().catch(() => {}).finally(sync); // a ?w=1 reload, if any, comes before the panel docks
initList(); // story badges on PR lists
initConversation(); // the story tag on a PR's Conversation tab
