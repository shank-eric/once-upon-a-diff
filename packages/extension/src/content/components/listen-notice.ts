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
import { Fragment, html, render, useLayoutEffect, useRef } from '/assets/preact.mjs';
import { wireStartListening, type ListenPort } from '@once-upon-a-diff/ui/listen';
import { hideUntilStyled, stopKeyEvents, stylesheetLink } from '@once-upon-a-diff/ui/dom';
import { bridge } from '../bridge.ts';
import { createListenOption } from '../listen.ts';
import { noticeRowTitle } from '../tag-model.ts';
import type { MissingListener } from '../tag-model.ts';

const HOST_ID = 'once-upon-listen-notice';
const MAX = 3;
const NOTICE_CSS_URL = chrome.runtime.getURL('content/components/listen-notice.css');

/**
 * One line of the notice: no session listening for this repo, with Start listening and a place for what happened (its note
 * and chooser). wireStartListening owns the button's and the note's contents once it is wired, so they stay put while the
 * notice draws again.
 */
function NoticeRow(props: {
  row: MissingListener;
  index: number;
  listen: ListenPort;
  onStarted?: () => void;
}) {
  const { row, index, listen } = props;
  const button = useRef<HTMLButtonElement | null>(null);
  const note = useRef<HTMLDivElement | null>(null);
  // wired once per button: wireStartListening keeps the button's resting label from the live DOM, so wiring it again mid-click
  // would save "Looking…" as that label. What changes between draws is read when a click needs it, through these.
  const where = useRef({ repo: row.repo, checkout: row.checkout });
  where.current.checkout = row.checkout;
  const started = useRef(props.onStarted);
  started.current = props.onStarted;
  useLayoutEffect(() => {
    wireStartListening(
      button.current as HTMLButtonElement,
      note.current as HTMLDivElement,
      { scope: 'repo', repo: row.repo },
      {
        ...listen,
        start: async (id, target) => {
          await listen.start(id, target);
          started.current?.();
        },
      },
      where.current,
    );
  }, []);
  const checkout = row.checkout && html` <span class="muted">· ${row.checkout}</span>`;
  const line = html`<div class="row"><span>No session listening for <b>${row.repo}</b>${checkout}</span><button data-i=${index} ref=${button} title=${noticeRowTitle(row)}>Start listening</button></div>`;
  return html`${line}<div class="note" data-n=${index} ref=${note} role="status" hidden></div>`;
}

/** The notice's lines (the first MAX repos, then "and N more repos") and its hide button. */
function Notice(props: { missing: MissingListener[]; listen: ListenPort; onStarted?: () => void }) {
  const { missing, listen, onStarted } = props;
  const rows = missing
    .slice(0, MAX)
    .map(
      (row, index) =>
        html`<${Fragment} key=${row.repo}><${NoticeRow} row=${row} index=${index} listen=${listen} onStarted=${onStarted} /></${Fragment}>`,
    );
  const more =
    missing.length > MAX &&
    html`<div class="muted">${`and ${missing.length - MAX} more repos`}</div>`;
  return html`<div class="row top"><div class="lines">${rows}${more}</div><button class="x" title="Hide until the page reloads" aria-label="Hide">×</button></div>`;
}

/** onStarted: a listen line was typed (the page looks again soon, so the row goes when the listener shows). */
export function listenNotice({ onStarted }: { onStarted?: () => void } = {}) {
  const listen = createListenOption(bridge.call);
  let host: HTMLDivElement | null = null;
  let root: HTMLDivElement | null = null;
  let dismissed = false;
  function remove() {
    if (root) {
      render(null, root); // so the rows' effects and the vnodes go with it
    }
    if (host) {
      host.remove();
    }
    host = null;
    root = null;
  }
  /** missing: from tag-model.ts's missingListeners */
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
    // drawn again on every call, and only what changed is touched, so a row's note stays put
    render(
      html`<${Notice} missing=${missing} listen=${listen} onStarted=${onStarted} />`,
      root as HTMLDivElement,
    );
  }
  return { set, remove };
}
