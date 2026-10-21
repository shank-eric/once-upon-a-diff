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
import { callBridge, extensionAlive } from '../bridge.js';
import { listenNotice } from '../ui/listen-notice.js';
import { tagFor, tagHtml, requestFor, missingListeners } from '../ui/story-tag.js';
import { createTagHost, showTag, clickedTagButton } from '../ui/tag-host.js';

const ATTR = 'data-dsm-badge';
const MAX_PER_CALL = 200;
const LOOK_AGAIN_MS = 15000;
const DEBOUNCE_MS = 300;
// the PR's title link, as classic lists, the new React lists and search results mark it
const TITLE_LINK =
  '[data-hovercard-type="pull_request"], .js-navigation-open, [data-testid*="title" i], h3 a, [id^="issue_"] a.Link--primary';

/** Title links to PRs on the page, one per row: [{link, row, repo, number}] */
function prLinks() {
  const out = [];
  const rows = new Set();
  for (const link of document.querySelectorAll('a[href*="/pull/"]')) {
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

const inFlight = (result) =>
  result.state === 'queued' || result.state === 'building' || !!result.updating;

export function createPullListPage() {
  const results = new Map(); // "owner/repo#n" -> {state, story, request}
  let listening = {}; // repo -> {ok, prompt, details, checkout}, from status-many
  const notice = listenNotice();
  const keyOf = (item) => prKey(item.repo, item.number);
  let scanning = false;
  let lastAsk = 0;
  let pending = 0;

  function tagHostFor(item) {
    let host = item.row.querySelector(`[${ATTR}="${keyOf(item)}"]`);
    if (!host) {
      host = createTagHost(ATTR, keyOf(item), (event) => onClick(event, item));
      item.link.after(host);
    }
    return host;
  }

  function render(item) {
    const result = results.get(keyOf(item));
    if (!result) {
      return;
    }
    showTag(tagHostFor(item), tagHtml(tagFor(result, item)));
  }

  async function onClick(event, item) {
    const button = clickedTagButton(event);
    if (!button) {
      return; // the Story link is a plain link
    }
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    const tag = tagFor(results.get(keyOf(item)), item);
    const retell = button.getAttribute('data-act') === 'retell';
    const answer = await callBridge('POST', '/api/builds', requestFor(tag, item, { retell }));
    if (answer.ok) {
      const previous = results.get(keyOf(item)) || {};
      results.set(
        keyOf(item),
        tag.act === 'update'
          ? {
              ...previous,
              updating: true,
              update_state: answer.body.state,
              request: answer.body.request,
            }
          : { state: answer.body.state, request: answer.body.request },
      );
    } else {
      button.disabled = false;
    }
    render(item);
  }

  async function scan(force) {
    if (scanning || !extensionAlive() || !isPullListPage(location)) {
      return;
    }
    scanning = true;
    try {
      const items = prLinks();
      const need = items.filter((item) => force || !results.has(keyOf(item)));
      if (need.length) {
        const answer = await callBridge('POST', '/api/stories/status-many', {
          prs: need
            .slice(0, MAX_PER_CALL)
            .map((item) => ({ repo: item.repo, number: item.number })),
        });
        if (!answer.ok) {
          return; // no bridge, no badges: the list stays as GitHub draws it
        }
        for (const result of answer.body.results) {
          results.set(prKey(result.repo, result.number), result);
        }
        if (answer.body.listening) {
          listening = { ...listening, ...answer.body.listening };
        }
        lastAsk = Date.now();
      }
      for (const item of items) {
        render(item);
      }
      const onPage = new Set(items.map((item) => item.repo.toLowerCase()));
      const here = Object.entries(listening).filter(([repo]) => onPage.has(repo.toLowerCase()));
      notice.set(missingListeners(Object.fromEntries(here)));
    } finally {
      scanning = false;
    }
  }

  // GitHub (and Refined GitHub) redraw list rows; put badges back after any change, debounced
  const observer = new MutationObserver((mutations) => {
    const ours = mutations.every(
      (mutation) =>
        mutation.target.nodeType === 1 &&
        mutation.target.closest &&
        mutation.target.closest(`[${ATTR}]`),
    );
    if (ours) {
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = 0;
        scan(false);
      }, DEBOUNCE_MS);
    }
  });

  /** Entering a list page starts watching it; leaving one stops. */
  function enterOrLeave(onList) {
    if (onList) {
      observer.observe(document.body, { childList: true, subtree: true });
      scan(false);
    } else {
      observer.disconnect();
      notice.remove();
    }
  }

  /** Every tick and navigation, from the router. */
  function route({ kind, navigated }) {
    if (navigated) {
      enterOrLeave(kind === 'list');
      return;
    }
    // while something is queued or building, look again every 15s
    if (
      kind === 'list' &&
      [...results.values()].some(inFlight) &&
      Date.now() - lastAsk > LOOK_AGAIN_MS
    ) {
      for (const [key, result] of results) {
        if (inFlight(result)) {
          results.delete(key);
        }
      }
      scan(false);
    }
  }

  function start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isPullListPage(location)) {
        results.clear();
        scan(true);
      }
    });
    enterOrLeave(isPullListPage(location));
  }

  return { route, start };
}
