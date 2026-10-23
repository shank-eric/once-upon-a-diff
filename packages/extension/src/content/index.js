/*
 * The extension's content script on github.com (started by
 * entrypoints/content.js). It routes by page kind (shared/util/github-paths.js):
 *   files         a PR's Files changed (/files or /changes): the story panel (pages/files-changed.js)
 *   conversation  a PR's Conversation tab: the story tag by the title (pages/conversation.js)
 *   list          PR lists and PR searches: a story tag per PR (pages/pull-list.js)
 *   other         nothing
 *
 * GitHub navigates without reloading (Turbo and React routes), so the router
 * watches the URL as well as the usual navigation events, and tells every
 * page what kind of page this is now: a page that isn't the current one takes
 * its elements off. Its tick (while the tab shows) is the pages' clock for
 * looking again, and coming back to the tab is one 'back' for all of them.
 */
import { pageKindOf } from '@once-upon-a-diff/shared/util/github-paths';
import { extensionAlive } from './bridge.js';
import { createFilesChangedPage } from './pages/files-changed.js';
import { createConversationPage } from './pages/conversation.js';
import { createPullListPage } from './pages/pull-list.js';

const TICK_MS = 700;
const BACK_MS = 1000; // focus and visibilitychange both fire on coming back: one 'back' for the two
const NAVIGATION_EVENTS = ['turbo:load', 'turbo:render', 'popstate', 'pageshow'];

/** Starts the router and every page. */
export function startContentScript() {
  const pages = [createFilesChangedPage(), createPullListPage(), createConversationPage()];
  let lastHref = location.href;
  let lastBack = 0;

  /**
   * reason: 'tick' (the URL watch, while the tab shows), 'event' (a navigation event) or 'back' (the tab got focus or
   * showed again); navigated: the URL changed since the last look.
   */
  function route(reason) {
    if (!extensionAlive() || (reason === 'tick' && document.visibilityState !== 'visible')) {
      return;
    }
    const navigated = location.href !== lastHref;
    lastHref = location.href;
    const kind = pageKindOf(location);
    for (const page of pages) {
      page.route({ kind, navigated, reason });
    }
  }

  setInterval(() => route('tick'), TICK_MS);
  for (const type of NAVIGATION_EVENTS) {
    window.addEventListener(type, () => route('event'));
  }
  const back = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastBack > BACK_MS) {
      lastBack = Date.now();
      route('back');
    }
  };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
  for (const page of pages) {
    page.start();
  }
}
