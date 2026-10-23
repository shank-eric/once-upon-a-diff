// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The story panel on the local page, the same one the extension puts on
 * GitHub, with the page's own callbacks: the bridge keeps its state, its
 * questions and its drafts, Add to fix before push makes a note, and the
 * panel's Fix before push sends the notes to a Claude session.
 */
import { storyOverlay } from '/assets/overlay.ts';
import { page, api, STORY_ID, STORY_PATH } from './page.ts';
import { narrow, reveal, unnarrow, forgetNarrowing } from './folds.ts';
import { placeNotes } from './notes.ts';

const panelData = () => ({ ...page.story, local: undefined });

function statusError(err) {
  let code = 'down';
  if (/token/.test(err.message)) {
    code = 'token';
  } else if (/HTTP 404|not found/.test(err.message)) {
    code = 'old';
  }
  throw Object.assign(err, { code });
}

/** Add to fix before push: the bridge makes the draft a note (once), which joins the checklist and the diff. */
async function addToFixBeforePush(chapter, index) {
  const note = await api('POST', `${STORY_PATH}/notes`, { chapter, index });
  page.story.local.notes = [
    ...page.story.local.notes.filter((existing) => existing.id !== note.id),
    note,
  ];
  placeNotes();
  return api('GET', `${STORY_PATH}/drafts`);
}

export function mount(initial) {
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
      api('POST', `${STORY_PATH}/ui`, page.lastUi).catch(() => {});
    },
    onFilter: narrow,
    reveal,
    onPosition: (position) =>
      api('POST', `${STORY_PATH}/position`, { ...position, url: location.href }).catch(() => {}),
    reads: () => api('GET', `${STORY_PATH}/read`),
    onRead: (read) => api('POST', `${STORY_PATH}/read`, read), // the bridge records the range's head commit with it
    onClose: () => {
      page.overlay = null;
      page.hidden = true;
      forgetNarrowing();
      unnarrow();
      api('POST', `${STORY_PATH}/ui`, { ...page.lastUi, hidden: true }).catch(() => {});
      showReopen();
    },
    ask: (question) => api('POST', `${STORY_PATH}/questions`, { ...question, url: location.href }),
    loadQuestions: () => api('GET', `${STORY_PATH}/questions`).then((answer) => answer.questions),
    markQuestions: (action, ids) => api('POST', `${STORY_PATH}/questions/marks`, { action, ids }),
    fixes: {
      load: () => api('GET', `${STORY_PATH}/fixes`),
      act: (body) => api('POST', `${STORY_PATH}/fixes`, body),
      note: (noteId, changes) =>
        api('POST', `${STORY_PATH}/notes/${encodeURIComponent(noteId)}`, changes),
      // the panel's notes changed (sent, fixed, edited): the diff and the checklist show the same
      onChange: (view) => {
        page.story.local.notes = view.notes;
        placeNotes();
      },
    },
    working: () => api('GET', `${STORY_PATH}/working`),
    drafts: {
      load: () => api('GET', `${STORY_PATH}/drafts`),
      act: (chapter, index, action) =>
        action === 'fix'
          ? addToFixBeforePush(chapter, index)
          : api('POST', `${STORY_PATH}/drafts`, { chapter, index, action }),
    },
    // Rebuild story / Rebuild from here: a build request for this story, which `once-upon local` finishes
    requestRebuild: (ask) => api('POST', `${STORY_PATH}/rebuild`, ask),
    pulse: () => api('GET', `${STORY_PATH}/pulse`),
    // the story or the commits moved: local.js reloads and redraws
    onPulse: (pulse) => {
      if (pulse.version !== page.story.version && page.onVersion) {
        page.onVersion(pulse.version);
      }
    },
    status: () =>
      api('GET', `/api/status?story=${encodeURIComponent(STORY_ID)}`).catch(statusError),
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
