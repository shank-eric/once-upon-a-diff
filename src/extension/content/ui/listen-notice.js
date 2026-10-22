/*
 * The page-level "No session listening for owner/name" notice, on PR lists
 * and a PR's Conversation tab: one line per repo on the page that has no
 * Claude session listening, each with "Copy prompt for Claude". The prompt is
 * the one-line `/once-upon-listen owner/name`, and its hover gives where to
 * start Claude Code and the long form for a session without the skill.
 * Our own element in its own shadow root, bottom right. It never touches
 * GitHub's page and posts nothing.
 */
import { copyWithFeedback } from './copy.js';
import { escapeHtml } from '../../shared/util/html.js';
import { stopKeyEvents } from '../../shared/util/dom.js';

const HOST_ID = 'once-upon-listen-notice';
const MAX = 3;
const CSS = `
  :host { all: initial; }
  .n { position: fixed; right: 16px; bottom: 16px; z-index: 98; max-width: 420px; display: flex; flex-direction: column; gap: 4px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 8px; padding: 6px 8px 6px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
  .row { display: flex; align-items: center; gap: 8px; }
  .row span { flex: 1; min-width: 0; }
  .muted { color: var(--fgColor-muted, #59636e); }
  button { font: inherit; color: inherit; background: var(--bgColor-muted, #f6f8fa); border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 999px; padding: 1px 9px; cursor: pointer; white-space: nowrap; }
  button:hover { border-color: var(--fgColor-accent, #0969da); color: var(--fgColor-accent, #0969da); }
  .x { border: 0; background: none; padding: 0 4px; color: var(--fgColor-muted, #59636e); align-self: flex-start; }
  code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

export function listenNotice() {
  let host = null;
  let root = null;
  let dismissed = false;
  let rows = [];
  let lastHtml = '';
  function remove() {
    if (host) {
      host.remove();
    }
    host = null;
    root = null;
    lastHtml = '';
  }
  /** @param {Array<{repo, prompt, details, checkout}>} missing, from story-tag.js's missingListeners */
  function set(missing) {
    if (dismissed || !missing.length) {
      return remove();
    }
    rows = missing;
    if (!host || !document.body.contains(host)) {
      host = document.createElement('div');
      host.id = HOST_ID;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${CSS}</style><div class="n" role="status"></div>`;
      root = shadow.querySelector('.n');
      root.addEventListener('click', (event) => {
        const button = /** @type {Element} */ (event.target).closest('button[data-i], button.x');
        if (!button) {
          return;
        }
        if (button.classList.contains('x')) {
          dismissed = true;
          remove();
          return;
        }
        const missingRow = rows[Number(button.getAttribute('data-i'))];
        if (missingRow) {
          copyWithFeedback(missingRow.prompt, button, button.getRootNode());
        }
      });
      stopKeyEvents(root);
      document.body.appendChild(host);
    }
    const shown = missing.slice(0, MAX);
    const html =
      shown
        .map((missingRow, i) => {
          const how = missingRow.checkout
            ? `Start Claude Code in ${missingRow.checkout} and paste ${missingRow.prompt}.`
            : `Start Claude Code in your ${missingRow.repo} checkout and paste ${missingRow.prompt}.`;
          const title = `${how}${missingRow.details ? `\n\nWithout the once-upon-listen skill: ${missingRow.details}` : ''}`;
          return (
            `<div class="row"><span>No session listening for <b>${escapeHtml(missingRow.repo)}</b>${missingRow.checkout ? ` <span class="muted">· ${escapeHtml(missingRow.checkout)}</span>` : ''}</span>` +
            `<button data-i="${i}" title="${escapeHtml(title)}">Copy prompt for Claude</button></div>`
          );
        })
        .join('') +
      (missing.length > MAX
        ? `<div class="muted">and ${missing.length - MAX} more repos</div>`
        : '');
    const next = `<div class="row" style="align-items:flex-start"><div style="flex:1">${html}</div><button class="x" title="Hide until the page reloads" aria-label="Hide">×</button></div>`;
    if (next !== lastHtml) {
      lastHtml = next;
      root.innerHTML = next;
    } // redrawn only when it changes, so "Copied" stays put
  }
  return { set, remove };
}
