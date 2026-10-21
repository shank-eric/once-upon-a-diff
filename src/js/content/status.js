/*
 * The small story status control on a PR's Files changed page, shown
 * whenever the story panel isn't: "Story ready" (opens the panel),
 * "Building story…" (with when it was asked for) or "Build story" (asks a
 * Claude session, through the bridge, to write one). It's our own button in
 * its own shadow root, so it never touches GitHub's controls or styles.
 */
import { copyWithFeedback } from './copy.js';

const HOST_ID = 'diff-story-status';

const CSS = `
  :host { all: initial; }
  .dss { position: fixed; right: 16px; bottom: 16px; z-index: 98; display: flex; align-items: center; gap: 8px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 999px; padding: 4px 6px 4px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12); opacity: .92; }
  .dss:hover { opacity: 1; }
  .dss[data-state="offline"] { opacity: .6; }
  .dss button { font: inherit; color: inherit; background: var(--bgColor-muted, #f6f8fa); border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 999px; padding: 2px 10px; cursor: pointer; }
  .dss button:hover { border-color: var(--fgColor-accent, #0969da); color: var(--fgColor-accent, #0969da); }
  .dss .label { white-space: nowrap; }
  .dss .muted { color: var(--fgColor-muted, #59636e); }
  .dss .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--borderColor-default, #d1d9e0);
    border-top-color: var(--fgColor-accent, #0969da); animation: dss-spin 0.9s linear infinite; }
  .dss .x { border: 0; background: none; padding: 0 4px; color: var(--fgColor-muted, #59636e); }
  @keyframes dss-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .dss .spin { animation: none; } }
`;

const BUILD = '<button data-act="build" title="Ask a Claude session to write a story for this PR">Build story</button>';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const time = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/** @param {{onOpen: () => void, onBuild: () => void}} handlers */
export function statusControl({ onOpen, onBuild }) {
  let host = null;
  let root = null;
  let dismissed = false;
  let prompt = '';
  function ensure() {
    if (host && document.body.contains(host)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="dss" role="status"></div>`;
    root = shadow.querySelector('.dss');
    root.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'open') onOpen();
      else if (act === 'build') { b.disabled = true; onBuild(); }
      else if (act === 'copy') copyWithFeedback(prompt, b, root);
      else if (act === 'dismiss') { dismissed = true; remove(); }
    });
    for (const type of ['keydown', 'keypress', 'keyup']) root.addEventListener(type, e => e.stopPropagation());
    document.body.appendChild(host);
  }
  function remove() {
    if (host) host.remove();
    host = null;
    root = null;
  }
  /** state: ready | building | none | offline | hidden. info: {requested_at, note, prompt} (prompt: no Claude session is listening) */
  function set(state, info = {}) {
    if (state === 'hidden' || dismissed) return remove();
    ensure();
    prompt = info.prompt || '';
    const copy = prompt && (state === 'building' || state === 'none')
      ? '<button data-act="copy" title="No Claude session is listening for build requests. Copy a prompt to paste into a Claude Code session, which then builds stories and answers questions">Copy prompt for Claude</button>' : '';
    root.setAttribute('data-state', state);
    const close = '<button class="x" data-act="dismiss" title="Hide this until the page reloads" aria-label="Hide">×</button>';
    if (state === 'ready') root.innerHTML = `<span class="label">Story ready</span><button data-act="open" title="Show the story panel">Read it</button>${close}`;
    else if (state === 'building') root.innerHTML = `<span class="spin" aria-hidden="true"></span><span class="label">Building story <span class="muted">· asked ${esc(time(info.requested_at))}${prompt ? ' · nobody is listening' : ''}</span></span>${copy}${close}`;
    else if (state === 'none') root.innerHTML = `<span class="label">${info.note ? `<span class="muted">${esc(info.note)}</span> ` : ''}No story yet</span>${BUILD}${copy}${close}`;
    else root.innerHTML = `<span class="label muted">${esc(info.note || 'Story bridge offline')}</span>${close}`;
  }
  return { set, remove };
}
