/*
 * PR lists (a repo's /pulls, the global /pulls, and PR search results): one
 * story tag after each PR's title, and the tag is the control
 * (ui/story-tag.js): Story opens Files changed, Build story or Update asks
 * for one, Queued and Building… show progress. Whether a session is listening
 * is said once for the page, per repo, by the notice (ui/listen-notice.js).
 * One batched bridge call per page. The tags are our own elements in their
 * own shadow roots; nothing of GitHub's is clicked.
 */
import { conversationPr, isPullListPage, prKey } from '../../shared/util/github-paths.js';
import { extensionAlive } from '../bridge.js';
import { createPrTags } from '../ui/pr-tags.js';

const ATTR = 'data-dsm-badge';
const DEBOUNCE_MS = 300;
// the PR's title link, as classic lists, the new React lists and search results mark it
const TITLE_LINK =
  '[data-hovercard-type="pull_request"], .js-navigation-open, [data-testid*="title" i], h3 a, [id^="issue_"] a.Link--primary';

/** Title links to PRs on the page, one per row: [{link, row, repo, number}] */
function prLinks() {
  const out = [];
  const rows = new Set();
  for (const link of /** @type {NodeListOf<HTMLAnchorElement>} */ (
    document.querySelectorAll('a[href*="/pull/"]')
  )) {
    if (link.closest(`[${ATTR}]`)) {
      continue;
    }
    const url = new URL(link.href, location.origin);
    const pr = conversationPr(url.pathname);
    if (!pr || url.origin !== location.origin) {
      continue;
    }
    const text = (link.textContent || '').trim();
    if (!text || /^#\d+$/.test(text)) {
      continue; // "#123" references, not titles
    }
    const isTitle = link.matches(TITLE_LINK) || !!link.closest('[data-testid*="title" i], h3, h4');
    if (!isTitle) {
      continue;
    }
    const row =
      link.closest('.js-issue-row, [role="listitem"], li, [data-testid*="row" i], tr, article') ||
      link.parentElement;
    if (rows.has(row)) {
      continue;
    }
    rows.add(row);
    out.push({ link, row, repo: pr.repo, number: pr.number });
  }
  return out;
}

export function createPullListPage() {
  const tags = createPrTags({ attr: ATTR });
  let scanning = false;
  let pending = 0;

  function render(item) {
    let host = item.row.querySelector(`[${ATTR}="${prKey(item.repo, item.number)}"]`);
    if (!host) {
      host = tags.hostFor(item);
      item.link.after(host);
    }
    tags.show(host, item);
  }

  /** Tags every PR on the page, looking up the ones it doesn't know yet (force: all of them; only: just these, again). */
  async function scan({ force = false, only = null } = {}) {
    if (scanning || !extensionAlive() || !isPullListPage(location)) {
      return;
    }
    scanning = true;
    try {
      const items = prLinks();
      const answer = await tags.look(only || items, { force: force || !!only });
      if (!answer.ok) {
        return; // no bridge, no badges: the list stays as GitHub draws it
      }
      for (const item of items) {
        render(item);
      }
      tags.showNotice(items.map((item) => item.repo));
    } finally {
      scanning = false;
    }
  }

  // GitHub (and Refined GitHub) redraw list rows; put badges back after any change, debounced
  const observer = new MutationObserver((mutations) => {
    const ours = mutations.every(
      (mutation) =>
        mutation.target.nodeType === 1 &&
        /** @type {Element} */ (mutation.target).closest &&
        /** @type {Element} */ (mutation.target).closest(`[${ATTR}]`),
    );
    if (ours) {
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = 0;
        scan();
      }, DEBOUNCE_MS);
    }
  });

  /** Entering a list page starts watching it; leaving one stops. */
  function enterOrLeave(onList) {
    if (onList) {
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
    } else {
      observer.disconnect();
      tags.hideNotice();
    }
  }

  /** Every tick and navigation, from the router. */
  function route({ kind, navigated, reason }) {
    if (navigated) {
      enterOrLeave(kind === 'list');
    } else if (kind === 'list' && reason === 'back') {
      scan({ force: true }); // back on the tab: another tab or a session may have moved things on
    } else if (kind === 'list' && !scanning) {
      const again = tags.due();
      if (again.length) {
        scan({ only: again });
      }
    }
  }

  function start() {
    enterOrLeave(isPullListPage(location));
  }

  return { route, start };
}
