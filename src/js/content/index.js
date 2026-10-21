/*
 * The extension's content script on github.com (loaded as a module by
 * content.js). It routes by page kind (shared/util/github-paths.js):
 *   files         a PR's Files changed (/files or /changes): the story panel (pages/files-changed.js)
 *   conversation  a PR's Conversation tab: the story tag by the title (pages/conversation.js)
 *   list          PR lists and PR searches: a story tag per PR (pages/pull-list.js)
 *   other         nothing
 *
 * GitHub navigates without reloading (Turbo and React routes), so the router
 * watches the URL as well as the usual navigation events, and tells every
 * page what kind of page this is now: a page that isn't the current one takes
 * its elements off. Each page also keeps its own slower polls.
 */
import { pageKindOf } from '../shared/util/github-paths.js';
import { extensionAlive } from './bridge.js';
import { createFilesChangedPage } from './pages/files-changed.js';
import { createConversationPage } from './pages/conversation.js';
import { createPullListPage } from './pages/pull-list.js';

const TICK_MS = 700;
const NAVIGATION_EVENTS = ['turbo:load', 'turbo:render', 'popstate', 'pageshow'];

const pages = [createFilesChangedPage(), createPullListPage(), createConversationPage()];
let lastHref = location.href;

/** reason: 'tick' (the URL watch) or 'event' (a navigation event); navigated: the URL changed since the last look. */
function route(reason) {
  if (!extensionAlive()) {
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
for (const page of pages) {
  page.start();
}
