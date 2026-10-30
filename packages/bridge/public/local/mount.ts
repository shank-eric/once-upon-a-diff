/*
 * The story panel on the local page, the same one the extension puts on
 * GitHub, with the page's own callbacks: the bridge keeps its state, its
 * questions and its drafts, Add to fix before push makes a note, and the
 * panel's Fix before push sends the notes to a Claude session.
 */
import { storyOverlay, type InitialUi } from '/assets/overlay.ts';
import type { LocalNote, StatusError } from '/assets/types.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { page, bridge, pageUrl, PARAMS } from './page.ts';
import { narrow, reveal, unnarrow, forgetNarrowing } from './folds.ts';
import { placeNotes } from './notes.ts';

const panelData = () => ({ ...page.story, local: undefined });

function statusError(err: Error): never {
  let code: StatusError['code'] = 'down';
  if (/token/.test(err.message)) {
    code = 'token';
  } else if (/HTTP 404|not found/.test(err.message)) {
    code = 'old';
  }
  throw Object.assign(err, { code });
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
  page.overlay = storyOverlay(panelData(), {
    initial,
    host: 'this page',
    stylesheets: { page: '/assets/panel/page.css', panel: '/assets/panel/panel.css' },
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
    onPosition: (position) =>
      bridge
        .ask(ROUTES.storyPosition, { params: PARAMS, body: { ...position, url: pageUrl() } })
        .catch(() => {}),
    reads: () => bridge.ask(ROUTES.readRead, { params: PARAMS }),
    onRead: (read) => bridge.ask(ROUTES.readNote, { params: PARAMS, body: read }), // the bridge records the range's head commit with it
    onClose: () => {
      page.overlay = null;
      page.hidden = true;
      forgetNarrowing();
      unnarrow();
      bridge
        .ask(ROUTES.storyUiWrite, { params: PARAMS, body: { ...page.lastUi, hidden: true } })
        .catch(() => {});
      showReopen();
    },
    ask: (question) =>
      bridge.ask(ROUTES.questionAsk, { params: PARAMS, body: { ...question, url: pageUrl() } }),
    loadQuestions: () =>
      bridge.ask(ROUTES.questionsRead, { params: PARAMS }).then((answer) => answer.questions),
    markQuestions: (action, ids, extra) =>
      bridge.ask(ROUTES.questionMarks, { params: PARAMS, body: { action, ids, ...extra } }),
    fixes: {
      load: () => bridge.ask(ROUTES.fixesRead, { params: PARAMS }),
      act: (body) => bridge.ask(ROUTES.fixesAct, { params: PARAMS, body }),
      note: (noteId, changes) =>
        // the panel edits only a note it drew, which has an id
        bridge.ask(ROUTES.noteUpdate, {
          params: { ...PARAMS, note: noteId as string },
          body: changes,
        }),
      // the panel's notes changed (sent, fixed, edited): the diff and the checklist show the same
      onChange: (view) => {
        // the view's notes are notes.json's, each with its state (shared FixNote leaves out `at`, `done`...)
        page.story.local.notes = view.notes;
        placeNotes();
      },
    },
    working: () => bridge.ask(ROUTES.working, { params: PARAMS }),
    drafts: {
      load: () => bridge.ask(ROUTES.draftsRead, { params: PARAMS }),
      act: (chapter, index, action) =>
        action === 'fix'
          ? addToFixBeforePush(chapter, index)
          : bridge.ask(ROUTES.draftsAct, { params: PARAMS, body: { chapter, index, action } }),
    },
    // Rebuild story / Rebuild from here: a build request for this story, which `once-upon local` finishes
    requestRebuild: (ask) => bridge.ask(ROUTES.storyRebuildWrite, { params: PARAMS, body: ask }),
    pulse: () => bridge.ask(ROUTES.storyPulse, { params: PARAMS }),
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
  });
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
