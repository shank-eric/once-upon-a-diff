/*
 * The page-level "No session listening for owner/name" notice, on PR lists
 * and a PR's Conversation tab: one line per repo on the page that has no
 * Claude session listening, each with "Start listening". The click goes to
 * the bridge, which types the one-line `/once-upon-listen owner/name` into an
 * idle Claude Code session in the repo (the same call the panel's and the
 * board's Start listening make). The hover gives the line and the long form
 * for a session that can't be typed into.
 * Our own element in its own shadow root, bottom right. It never touches
 * GitHub's page and posts nothing.
 */
import { wireStartListening } from '@once-upon-a-diff/ui/listen';
import { bridge } from '../bridge.ts';
import { createListenOption } from '../listen.ts';
import { noticeRowHtml } from './story-tag.ts';
import type { MissingListener } from './story-tag.ts';
import { html } from '@once-upon-a-diff/protocol/domain/html';
import { hideUntilStyled, setHtml, stopKeyEvents, stylesheetLink } from '@once-upon-a-diff/ui/dom';

const HOST_ID = 'once-upon-listen-notice';
const MAX = 3;
const NOTICE_CSS_URL = chrome.runtime.getURL('content/ui/listen-notice.css');

/** onStarted: a listen line was typed (the page looks again soon, so the row goes when the listener shows). */
export function listenNotice({ onStarted }: { onStarted?: () => void } = {}) {
  const listen = createListenOption(bridge.call);
  let host: HTMLDivElement | null = null;
  let root: HTMLDivElement | null = null;
  let dismissed = false;
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
        if ((event.target as Element).closest('button.x')) {
          dismissed = true;
          remove();
        }
      });
      stopKeyEvents(root);
      document.body.appendChild(host);
    }
    const lines = missing.slice(0, MAX).map(noticeRowHtml);
    const more =
      missing.length > MAX && html`<div class="muted">and ${missing.length - MAX} more repos</div>`;
    const next = html`<div class="row top"><div class="lines">${lines}${more}</div><button class="x" title="Hide until the page reloads" aria-label="Hide">×</button></div>`;
    if (String(next) !== lastHtml) {
      lastHtml = String(next);
      const draw = root as HTMLDivElement; // made above when missing
      setHtml(draw, next);
      // each row's Start listening: its note and the chooser live in the row, and stay while the html is the same
      missing.slice(0, MAX).forEach((row, i) => {
        const button = draw.querySelector<HTMLButtonElement>(`button[data-i="${i}"]`);
        const note = draw.querySelector<HTMLElement>(`.note[data-n="${i}"]`);
        if (button && note) {
          wireStartListening(
            button,
            note,
            { scope: 'repo', repo: row.repo },
            {
              ...listen,
              start: async (id, target) => {
                await listen.start(id, target);
                onStarted?.();
              },
            },
            row,
          );
        }
      });
    } // redrawn only when it changes, so a note stays put
  }
  return { set, remove };
}
