/*
 * The story panel on the local page, the same one the extension puts on
 * GitHub, with the page's own callbacks: the bridge keeps its state, its
 * questions and its drafts, Add to fix before push makes a note, and the
 * panel's Fix before push sends the notes to a Claude session.
 */
import { storyOverlay, type InitialUi } from '/assets/panel/shell/overlay.ts';
import { bridgeOptions } from '/assets/panel/host/bridge-options.ts';
import { createHostPage } from '/assets/host-github/diff-dom.ts';
import type { PanelHost } from '/assets/panel/host/host.ts';
import type { LocalNote } from '/assets/types.ts';
import { ROUTES } from '/assets/contracts/routes.ts';
import { bridgeProblem, type BridgeError } from '/assets/api-client/client.ts';
import { page, bridge, pageUrl, PARAMS, STORY_ID, usage } from './page.ts';
import { narrow, reveal, unnarrow, forgetNarrowing } from '/assets/local/diff/folds.ts';
import { placeNotes } from '/assets/local/diff/notes.ts';
import { redrawSend } from '/assets/local/diff/send.ts';

/** The panel's host here: the local diff view's DOM (it has GitHub's /changes shapes) and the page's fetch to the bridge. */
const host: PanelHost = {
  createPage: createHostPage,
  client: bridge,
  storyId: STORY_ID,
  pageUrl,
  count: usage.count,
};

const panelData = () => ({ ...page.story, local: undefined });

function statusError(err: BridgeError): never {
  throw Object.assign(err, { code: bridgeProblem(err) });
}

/** Add to fix before push: the bridge makes the draft a note (once), which joins the checklist and the diff. */
async function addToFixBeforePush(chapter: number, index: number) {
  const note = (await bridge.ask(ROUTES.noteAdd, {
    params: PARAMS,
    body: { chapter, index },
  })) as LocalNote;
  page.story.local.notes = [
    ...page.story.local.notes.filter((existing) => existing.id !== note.id),
    note,
  ];
  placeNotes();
  return bridge.ask(ROUTES.draftsRead, { params: PARAMS });
}

export function mount(initial: InitialUi) {
  if (page.overlay) {
    page.overlay.destroy();
  }
  removeReopen();
  const common = bridgeOptions(host);
  page.overlay = storyOverlay(
    panelData(),
    {
      ...common,
      initial,
      host: 'this page',
      stylesheets: {
        page: '/assets/panel/css/page.css',
        panel: '/assets/panel/css/panel.css',
        ui: '/assets/ui-kit/css/ui.css',
      },
      commentsTitle: 'Fix before push (drafted)',
      onState: (panelState) => {
        page.lastUi = { ...panelState, hidden: false };
        bridge.ask(ROUTES.storyUiWrite, { params: PARAMS, body: page.lastUi }).catch(() => {});
      },
      // a drag: the new size is every story's (prefs.json), here and on GitHub
      onLayout: (layout) => {
        page.layout = { ...page.layout, ...layout };
        bridge.ask(ROUTES.storyPrefsWrite, { params: PARAMS, body: { layout } }).catch(() => {});
      },
      onFilter: narrow,
      reveal,
      onClose: () => {
        page.overlay = null;
        redrawSend();
        page.hidden = true;
        forgetNarrowing();
        unnarrow();
        bridge
          .ask(ROUTES.storyUiWrite, { params: PARAMS, body: { ...page.lastUi, hidden: true } })
          .catch(() => {});
        showReopen();
      },
      fixes: {
        ...common.fixes,
        // the panel's notes changed (sent, fixed, edited): the diff and the checklist show the same
        onChange: (view) => {
          // the view's notes are notes.json's, each with its state (shared FixNote leaves out `at`, `done`...)
          page.story.local.notes = view.notes;
          placeNotes();
        },
      },
      drafts: {
        ...common.drafts,
        act: (chapter, index, action) =>
          action === 'fix'
            ? addToFixBeforePush(chapter, index)
            : common.drafts.act(chapter, index, action),
      },
      // the story or the commits moved: local.js reloads and redraws
      onPulse: (pulse) => {
        if (pulse.version !== page.story.version && page.onVersion) {
          page.onVersion(pulse.version);
        }
      },
      status: () => bridge.ask(ROUTES.storyStatus, { params: PARAMS }).catch(statusError),
      // Start listening: the story's own routes type the listen line into an idle session (the board's routes need the board's key)
      listen: {
        sessions: () =>
          bridge
            .ask(ROUTES.storyListenSessions, { params: PARAMS })
            .then((answer) => answer.sessions),
        start: async (session, target) => {
          await bridge.ask(ROUTES.storyListen, {
            params: PARAMS,
            body: { session, scope: target.scope },
          });
        },
      },
    },
    host,
  );
  redrawSend(); // Send needs the panel that is now open
}

/** Mounts again on the step and scroll the panel has now (a redraw under it). */
export function remount() {
  if (!page.hidden) {
    mount(
      page.overlay ? { ...page.overlay.state, bodyScroll: page.overlay.bodyScroll } : page.lastUi,
    );
  }
}

export function showReopen() {
  removeReopen();
  const button = document.createElement('button');
  button.className = 'ou-local-reopen';
  button.type = 'button';
  button.textContent = 'Show story';
  button.onclick = () => {
    page.hidden = false;
    mount({ ...page.lastUi });
  };
  document.body.appendChild(button);
}

function removeReopen() {
  document.querySelector('.ou-local-reopen')?.remove();
}
