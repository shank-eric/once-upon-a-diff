/*
 * The page-level "No session listening for owner/name" notice, on PR lists
 * and a PR's Conversation tab: one line per repo on the page that has no
 * Claude session listening, each with "Copy prompt for Claude". The prompt is
 * the one-line `/once-upon-listen owner/name`, and its hover gives where to
 * start Claude Code and the long form for a session without the skill.
 * Our own element in its own shadow root, bottom right. It never touches
 * GitHub's page and posts nothing.
 */
import { copyWithFeedback } from './copy.ts';
import type { MissingListener } from './story-tag.ts';
import { html } from '@once-upon-a-diff/shared/util/html';
import {
  hideUntilStyled,
  setHtml,
  stopKeyEvents,
  stylesheetLink,
} from '@once-upon-a-diff/shared/util/dom';

const HOST_ID = 'once-upon-listen-notice';
const MAX = 3;
const NOTICE_CSS_URL = chrome.runtime.getURL('content/ui/listen-notice.css');

export function listenNotice() {
  let host: HTMLDivElement | null = null;
  let root: HTMLDivElement | null = null;
  let dismissed = false;
  let rows: MissingListener[] = [];
  let lastHtml = '';
  function remove() {
    if (host) {
      host.remove();
    }
    host = null;
    root = null;
    lastHtml = '';
  }
  /** missing: from story-tag.ts's missingListeners */
  function set(missing: MissingListener[]) {
    if (dismissed || !missing.length) {
      return remove();
    }
    rows = missing;
    if (!host || !document.body.contains(host)) {
      host = document.createElement('div');
      host.id = HOST_ID;
      const shadow = host.attachShadow({ mode: 'open' });
      const link = stylesheetLink(NOTICE_CSS_URL);
      root = document.createElement('div');
      root.className = 'n';
      root.setAttribute('role', 'status');
      shadow.append(link, root);
      hideUntilStyled(host, [link]);
      root.addEventListener('click', (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          'button[data-i], button.x',
        );
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
    const lines = shown.map((missingRow, i) => {
      const how = missingRow.checkout
        ? `Start Claude Code in ${missingRow.checkout} and paste ${missingRow.prompt}.`
        : `Start Claude Code in your ${missingRow.repo} checkout and paste ${missingRow.prompt}.`;
      const title = `${how}${missingRow.details ? `\n\nWithout the once-upon-listen skill: ${missingRow.details}` : ''}`;
      const checkout =
        missingRow.checkout && html` <span class="muted">· ${missingRow.checkout}</span>`;
      return html`<div class="row"><span>No session listening for <b>${missingRow.repo}</b>${checkout}</span><button data-i="${i}" title="${title}">Copy prompt for Claude</button></div>`;
    });
    const more =
      missing.length > MAX && html`<div class="muted">and ${missing.length - MAX} more repos</div>`;
    const next = html`<div class="row top"><div class="lines">${lines}${more}</div><button class="x" title="Hide until the page reloads" aria-label="Hide">×</button></div>`;
    if (String(next) !== lastHtml) {
      lastHtml = String(next);
      setHtml(root as HTMLDivElement, next); // made above when missing
    } // redrawn only when it changes, so "Copied" stays put
  }
  return { set, remove };
}
