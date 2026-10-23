/*
 * The story panel on the local page, the same one the extension puts on
 * GitHub, with the page's own callbacks: the bridge keeps its state, its
 * questions and its drafts, Add to fix before push makes a note, and the
 * panel's Fix before push sends the notes to a Claude session.
 */
import { storyOverlay, type InitialUi } from '/assets/overlay.ts';
import type {
  BridgeStatus,
  DraftsAnswer,
  FixesView,
  LocalNote,
  Question,
  QuestionMarksAnswer,
  ReadInfo,
  RebuildView,
  Pulse,
  StatusError,
  WorkingMark,
} from '/assets/types.ts';
import { page, api, pageUrl, STORY_PATH } from './page.ts';
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
  const note = await api<LocalNote>('POST', `${STORY_PATH}/notes`, { chapter, index });
  page.story.local.notes = [
    ...page.story.local.notes.filter((existing) => existing.id !== note.id),
    note,
  ];
  placeNotes();
  return api<DraftsAnswer>('GET', `${STORY_PATH}/drafts`);
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
      api('POST', `${STORY_PATH}/ui`, page.lastUi).catch(() => {});
    },
    onFilter: narrow,
    reveal,
    onPosition: (position) =>
      api('POST', `${STORY_PATH}/position`, { ...position, url: pageUrl() }).catch(() => {}),
    reads: () => api<ReadInfo>('GET', `${STORY_PATH}/read`),
    onRead: (read) => api('POST', `${STORY_PATH}/read`, read), // the bridge records the range's head commit with it
    onClose: () => {
      page.overlay = null;
      page.hidden = true;
      forgetNarrowing();
      unnarrow();
      api('POST', `${STORY_PATH}/ui`, { ...page.lastUi, hidden: true }).catch(() => {});
      showReopen();
    },
    ask: (question) => api('POST', `${STORY_PATH}/questions`, { ...question, url: pageUrl() }),
    loadQuestions: () =>
      api<{ questions: Question[] }>('GET', `${STORY_PATH}/questions`).then(
        (answer) => answer.questions,
      ),
    markQuestions: (action, ids) =>
      api<QuestionMarksAnswer>('POST', `${STORY_PATH}/questions/marks`, { action, ids }),
    fixes: {
      load: () => api<FixesView>('GET', `${STORY_PATH}/fixes`),
      act: (body) => api<FixesView>('POST', `${STORY_PATH}/fixes`, body),
      note: (noteId, changes) =>
        // the panel edits only a note it drew, which has an id
        api('POST', `${STORY_PATH}/notes/${encodeURIComponent(noteId as string)}`, changes),
      // the panel's notes changed (sent, fixed, edited): the diff and the checklist show the same
      onChange: (view) => {
        // the view's notes are notes.json's, each with its state (shared FixNote leaves out `at`, `done`...)
        page.story.local.notes = view.notes;
        placeNotes();
      },
    },
    working: () => api<{ marks?: WorkingMark[] }>('GET', `${STORY_PATH}/working`),
    drafts: {
      load: () => api<DraftsAnswer>('GET', `${STORY_PATH}/drafts`),
      act: (chapter, index, action) =>
        action === 'fix'
          ? addToFixBeforePush(chapter, index)
          : api<DraftsAnswer>('POST', `${STORY_PATH}/drafts`, { chapter, index, action }),
    },
    // Rebuild story / Rebuild from here: a build request for this story, which `once-upon local` finishes
    requestRebuild: (ask) =>
      api<{ rebuild?: RebuildView | null }>('POST', `${STORY_PATH}/rebuild`, ask),
    pulse: () => api<Pulse>('GET', `${STORY_PATH}/pulse`),
    // the story or the commits moved: local.js reloads and redraws
    onPulse: (pulse) => {
      if (pulse.version !== page.story.version && page.onVersion) {
        page.onVersion(pulse.version);
      }
    },
    status: () => api<BridgeStatus>('GET', `${STORY_PATH}/status`).catch(statusError),
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
