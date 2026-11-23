/*
 * The bridge's local page: a diff of local commits drawn with the same DOM shapes as GitHub's /changes page (local/diff/), so
 * the very same story panel runs on it unchanged (local/mount.ts). This module is the page's start: it loads highlight.js, the
 * story, and the panel's saved state, draws the page (local/app.ts, from the store in local/store.ts), and mounts the panel.
 */
import { ROUTES } from '/assets/contracts/routes.ts';
import { page, bridge, PARAMS } from '/assets/local/page.ts';
import { store, storyOf } from '/assets/local/store.ts';
import { drawInto } from '/assets/local/app.ts';
import { mount } from '/assets/local/mount.ts';
import { reloadIfChanged } from '/assets/local/actions.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { InitialUi } from '/assets/panel/shell/overlay.ts';
import { withLayout, type Layout } from '/assets/panel/shell/layout.ts';

const app = document.getElementById('ou-local-app') as HTMLElement; // the page's shell has it

async function start() {
  // all four requests go out together: the story and the saved state do not wait for highlight.js to load and parse
  const loadHljs = import('/assets/highlight.mjs').then(
    (module) => module.default,
    () => null,
  );
  const loadStory = bridge.ask(ROUTES.story, { params: PARAMS }).then(
    (data) => ({ story: data as LocalStoryData }),
    (err: Error) => ({ error: err }),
  );
  const loadSaved = bridge
    .ask(ROUTES.storyUiRead, { params: PARAMS })
    .catch(() => ({})) as Promise<InitialUi>;
  const loadPrefs = bridge
    .ask(ROUTES.storyPrefsRead, { params: PARAMS })
    .catch(() => null) as Promise<{
    layout?: Layout;
  } | null>;
  page.hljs = await loadHljs;
  const loaded = await loadStory;
  if ('error' in loaded) {
    store.set({ loadError: loaded.error.message });
    drawInto(app);
    return;
  }
  const { story } = loaded;
  document.title = story.title;
  const [saved, prefs] = await Promise.all([loadSaved, loadPrefs]);
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
}
start();
