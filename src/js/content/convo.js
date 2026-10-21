/*
 * A PR's Conversation tab (/owner/repo/pull/N): the same single story tag as
 * PR lists (tag.js), next to the PR's title, and the page-level notice when
 * no session is listening for the repo (notice.js). It comes back after
 * GitHub redraws the header or navigates in the page, looks again every 15s
 * while a story is queued or building, and only reads from GitHub's page.
 */
import { conversationPr } from '../shared/util/github-paths.js';
import { tagFor, tagHtml, requestFor, missingListeners, TAG_CSS } from './tag.js';
import { listenNotice } from './notice.js';
import { callBridge, extensionAlive } from './bridge.js';

const ATTR = 'data-dsm-convo';
/** The PR title on the classic and the React PR pages. */
function titleEl() {
  return document.querySelector(
    '.gh-header-title .js-issue-title, h1.gh-header-title, [data-component="PH_Title"] h1, [data-testid="issue-title"], main h1 bdi, main h1',
  );
}

export function initConversation() {
  const notice = listenNotice();
  let pr = null; // {repo, number, key}
  let result = null;
  let listening = {};
  let askedAt = 0;
  let busy = false;

  function host() {
    let h = document.querySelector(`[${ATTR}]`);
    if (h && h.getAttribute(ATTR) !== pr.key) {
      h.remove();
      h = null;
    }
    if (h) {
      return h;
    }
    const title = titleEl();
    if (!title) {
      return null;
    }
    h = document.createElement('span');
    h.setAttribute(ATTR, pr.key);
    const shadow = h.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${TAG_CSS}</style><span class="slot"></span>`;
    shadow.addEventListener('click', onClick);
    for (const t of ['keydown', 'keypress', 'keyup']) {
      shadow.addEventListener(t, (e) => e.stopPropagation());
    }
    title.after(h);
    return h;
  }

  function render() {
    if (!pr || !result) {
      return;
    }
    const h = host();
    if (h) {
      const slot = h.shadowRoot.querySelector('.slot');
      const html = tagHtml(tagFor(result, pr));
      if (slot.getAttribute('data-html') !== html) {
        slot.setAttribute('data-html', html);
        slot.innerHTML = html;
      }
    }
    notice.set(missingListeners(listening));
  }

  async function look() {
    if (busy || !pr) {
      return;
    }
    busy = true;
    const mine = pr;
    try {
      const r = await callBridge('POST', '/api/stories/status-many', {
        prs: [{ repo: pr.repo, number: pr.number }],
      });
      if (pr !== mine || !r.ok) {
        return;
      } // no bridge, no tag: the page stays as GitHub draws it
      result = r.body.results[0] || null;
      listening = r.body.listening || {};
      askedAt = Date.now();
      render();
    } finally {
      busy = false;
    }
  }

  async function onClick(e) {
    const target = e.composedPath()[0];
    const b = target.closest && target.closest('button[data-act]');
    if (!b || !pr) {
      return;
    } // Story is a plain link to Files changed
    e.preventDefault();
    e.stopPropagation();
    b.disabled = true;
    const t = tagFor(result, pr);
    const r = await callBridge(
      'POST',
      '/api/builds',
      requestFor(t, pr, { retell: b.getAttribute('data-act') === 'retell' }),
    );
    if (r.ok) {
      result =
        t.act === 'update'
          ? { ...result, updating: true, update_state: r.body.state, request: r.body.request }
          : { state: r.body.state, request: r.body.request };
      render();
    } else {
      b.disabled = false;
    }
  }

  function follow() {
    if (!extensionAlive()) {
      return;
    }
    const now = conversationPr(location.pathname);
    const key = now ? `${now.repo}#${now.number}`.toLowerCase() : null;
    if (!now) {
      if (pr) {
        pr = null;
        result = null;
        document.querySelector(`[${ATTR}]`)?.remove();
        notice.remove();
      }
      return;
    }
    if (!pr || pr.key !== key) {
      pr = { ...now, key };
      result = null;
      listening = {};
      look();
      return;
    }
    // GitHub redraws the header: put the tag back
    if (result && !document.querySelector(`[${ATTR}="${CSS.escape(key)}"]`)) {
      render();
    }
    const inFlight =
      result && (result.state === 'queued' || result.state === 'building' || result.updating);
    if ((inFlight || missingListeners(listening).length) && Date.now() - askedAt > 15000) {
      look();
    }
  }

  setInterval(follow, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pr) {
      look();
    }
  });
  follow();
}
