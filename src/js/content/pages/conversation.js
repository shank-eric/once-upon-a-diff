/*
 * A PR's Conversation tab (/owner/repo/pull/N): the same single story tag as
 * PR lists (ui/pr-tags.js), next to the PR's title, and the page-level
 * notice when no session is listening for the repo. It comes back after
 * GitHub redraws the header or navigates in the page, looks again while a
 * story is queued or building, and only reads from GitHub's page.
 */
import { conversationPr, pageKindOf, prKey } from '../../shared/util/github-paths.js';
import { extensionAlive } from '../bridge.js';
import { createPrTags, titleElement } from '../ui/pr-tags.js';

const ATTR = 'data-dsm-convo';

export function createConversationPage() {
  const tags = createPrTags({ attr: ATTR });
  let pr = null; // {repo, number, key}
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
    host = tags.hostFor(pr);
    title.after(host);
    return host;
  }

  function render() {
    if (!pr || !tags.resultOf(pr)) {
      return;
    }
    const host = tagHostOnPage();
    if (host) {
      tags.show(host, pr);
    }
    tags.showNotice([pr.repo]);
  }

  async function look() {
    if (busy || !pr) {
      return;
    }
    busy = true;
    const mine = pr;
    try {
      const answer = await tags.look([pr], { force: true });
      if (pr === mine && answer.ok) {
        render(); // no bridge, no tag: the page stays as GitHub draws it
      }
    } finally {
      busy = false;
    }
  }

  /** Every tick and navigation, from the router: follow the PR on screen. */
  function route({ kind, reason }) {
    const now = kind === 'conversation' ? conversationPr(location.pathname) : null;
    const key = now ? prKey(now.repo, now.number) : null;
    if (!now) {
      if (pr) {
        pr = null;
        tags.clear();
        document.querySelector(`[${ATTR}]`)?.remove();
      }
      return;
    }
    if (!pr || pr.key !== key || reason === 'back') {
      pr = { ...now, key };
      look();
      return;
    }
    // GitHub redraws the header: put the tag back
    if (tags.resultOf(pr) && !document.querySelector(`[${ATTR}="${CSS.escape(key)}"]`)) {
      render();
    }
    if (tags.due([pr]).length) {
      look();
    }
  }

  function start() {
    if (extensionAlive()) {
      route({ kind: pageKindOf(location) });
    }
  }

  return { route, start };
}
