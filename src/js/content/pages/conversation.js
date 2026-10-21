/*
 * A PR's Conversation tab (/owner/repo/pull/N): the same single story tag as
 * PR lists (ui/story-tag.js), next to the PR's title, and the page-level
 * notice when no session is listening for the repo (ui/listen-notice.js). It
 * comes back after GitHub redraws the header or navigates in the page, looks
 * again every 15s while a story is queued or building, and only reads from
 * GitHub's page.
 */
import { conversationPr, pageKindOf, prKey } from '../../shared/util/github-paths.js';
import { callBridge, extensionAlive } from '../bridge.js';
import { listenNotice } from '../ui/listen-notice.js';
import { tagFor, tagHtml, requestFor, missingListeners } from '../ui/story-tag.js';
import { createTagHost, showTag, clickedTagButton } from '../ui/tag-host.js';

const ATTR = 'data-dsm-convo';
const LOOK_AGAIN_MS = 15000;

/** The PR title on the classic and the React PR pages. */
function titleElement() {
  return document.querySelector(
    '.gh-header-title .js-issue-title, h1.gh-header-title, [data-component="PH_Title"] h1, [data-testid="issue-title"], main h1 bdi, main h1',
  );
}

export function createConversationPage() {
  const notice = listenNotice();
  let pr = null; // {repo, number, key}
  let result = null;
  let listening = {};
  let askedAt = 0;
  let busy = false;

  /** Our tag's host after the title, made (again) when it's missing or is for another PR. */
  function tagHostOnPage() {
    let host = document.querySelector(`[${ATTR}]`);
    if (host && host.getAttribute(ATTR) !== pr.key) {
      host.remove();
      host = null;
    }
    if (host) {
      return host;
    }
    const title = titleElement();
    if (!title) {
      return null;
    }
    host = createTagHost(ATTR, pr.key, onClick);
    title.after(host);
    return host;
  }

  function render() {
    if (!pr || !result) {
      return;
    }
    const host = tagHostOnPage();
    if (host) {
      showTag(host, tagHtml(tagFor(result, pr)));
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
      const answer = await callBridge('POST', '/api/stories/status-many', {
        prs: [{ repo: pr.repo, number: pr.number }],
      });
      if (pr !== mine || !answer.ok) {
        return; // no bridge, no tag: the page stays as GitHub draws it
      }
      result = answer.body.results[0] || null;
      listening = answer.body.listening || {};
      askedAt = Date.now();
      render();
    } finally {
      busy = false;
    }
  }

  async function onClick(event) {
    const button = clickedTagButton(event);
    if (!button || !pr) {
      return; // Story is a plain link to Files changed
    }
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    const tag = tagFor(result, pr);
    const retell = button.getAttribute('data-act') === 'retell';
    const answer = await callBridge('POST', '/api/builds', requestFor(tag, pr, { retell }));
    if (answer.ok) {
      result =
        tag.act === 'update'
          ? {
              ...result,
              updating: true,
              update_state: answer.body.state,
              request: answer.body.request,
            }
          : { state: answer.body.state, request: answer.body.request };
      render();
    } else {
      button.disabled = false;
    }
  }

  /** Every tick and navigation, from the router: follow the PR on screen. */
  function route({ kind }) {
    const now = kind === 'conversation' ? conversationPr(location.pathname) : null;
    const key = now ? prKey(now.repo, now.number) : null;
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
    if ((inFlight || missingListeners(listening).length) && Date.now() - askedAt > LOOK_AGAIN_MS) {
      look();
    }
  }

  function start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && pr) {
        look();
      }
    });
    if (extensionAlive()) {
      route({ kind: pageKindOf(location) });
    }
  }

  return { route, start };
}
