/*
 * The bridge's local page: a diff of local commits drawn with the same DOM shapes as GitHub's /changes page (local/diff/), so
 * the very same story panel runs on it unchanged (local/mount.ts). This module is the page's start: it loads highlight.js, the
 * story, and the panel's saved state, draws the page (local/app.ts, from the store in local/store.ts), and mounts the panel.
 */
import { ROUTES } from '/assets/contracts/routes.ts';
import { page, bridge, PARAMS, OPEN_PUSH } from '/assets/local/page.ts';
import { store, storyOf } from '/assets/local/store.ts';
import { drawInto } from '/assets/local/app.ts';
import { mount } from '/assets/local/mount.ts';
import { openDialog, reloadIfChanged } from '/assets/local/actions.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { InitialUi } from '/assets/panel/shell/overlay.ts';
import { withLayout, type Layout } from '/assets/panel/shell/layout.ts';

const app = document.getElementById('ou-local-app') as HTMLElement; // the page's shell has it

async function start() {
  page.hljs = await import('/assets/highlight.mjs').then(
    (module) => module.default,
    () => null,
  );
  let story: LocalStoryData;
  try {
    story = (await bridge.ask(ROUTES.story, { params: PARAMS })) as LocalStoryData;
  } catch (err) {
    store.set({ loadError: (err as Error).message });
    drawInto(app);
    return;
  }
  document.title = story.title;
  const [saved, prefs] = await Promise.all([
    bridge.ask(ROUTES.storyUiRead, { params: PARAMS }).catch(() => ({})) as Promise<InitialUi>,
    bridge.ask(ROUTES.storyPrefsRead, { params: PARAMS }).catch(() => null) as Promise<{
      layout?: Layout;
    } | null>,
  ]);
  // the story's own step and folds, at the size last dragged on any story
  page.layout = prefs?.layout || null;
  page.lastUi = withLayout(saved, page.layout);
  store.set({ story, hidden: !!page.lastUi.hidden });
  drawInto(app);
  if (!store.get().hidden) {
    mount(page.lastUi);
  }
  window.__onceUponLocal = {
    get story() {
      return storyOf();
    },
    get overlay() {
      return page.overlay;
    },
  };
  page.onVersion = reloadIfChanged;
  if (OPEN_PUSH) {
    // the board's Push: its link asks for the box (Push to the default branch, or Push for the open PR's branch)
    openDialog(story.local.ship === 'push' ? 'push' : 'push-ahead');
  }
}
start();
