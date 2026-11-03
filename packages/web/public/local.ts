/*
 * The bridge's local page: a diff of local commits drawn with the same DOM
 * shapes as GitHub's /changes page (local/diff-view.js), so the very same
 * story panel runs on it unchanged (local/mount.js).
 *
 * Here the page owns the review state that GitHub would own: Viewed toggles
 * and line notes go to the bridge, and notes are "fix before push" items
 * (local/notes.js). Other chapters' lines in a shared file fold away
 * (local/folds.js). Create pull request pushes the branch and opens GitHub's
 * compare page, on the reviewer's click (local/pull-request.ts). This module draws the page, handles its clicks, and
 * follows the story and the commits.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { page, bridge, PARAMS, OPEN_PUSH } from '/assets/local/page.ts';
import { treeHtml, fileHtml, headerHtml, resetHighlightBudget } from '/assets/local/diff-view.ts';
import { placeNotes, openEditor } from '/assets/local/notes.ts';
import { openFold, openRun, forgetNarrowing } from '/assets/local/folds.ts';
import { mount, remount, showReopen } from '/assets/local/mount.ts';
import { lookForPull, openPrBox } from '/assets/local/pull-request.ts';
import { openPushBox } from '/assets/local/push.ts';
import { openPushAheadBox } from '/assets/local/push-ahead.ts';
import { sendNotes } from '/assets/local/send.ts';
import { toggleApprove } from '/assets/local/approve.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { InitialUi } from '/assets/panel/overlay.ts';
import { withLayout, type Layout } from '/assets/panel/layout.ts';
import type { LocalNote } from '/assets/types.ts';

const POLL_MS = 5000;
// a hidden tab doesn't poll, but its page is still open: it says so about once a minute (services/listeners/auto-stop.ts)
const STILL_OPEN_MS = 60000;
const app = document.getElementById('ou-local-app') as HTMLElement; // the page's shell has it

function render() {
  const keep = window.scrollY;
  forgetNarrowing();
  resetHighlightBudget();
  const { files } = page.story.local;
  setHtml(
    app,
    html`${headerHtml()}<div class="ou-local-layout"><nav class="ou-local-tree" role="tree" aria-label="Changed files">${treeHtml(files.map((file) => file.rel))}</nav>
    <main class="ou-local-files">${files.map(fileHtml)}</main></div>`,
  );
  placeNotes();
  window.scrollTo({ top: keep });
}

const fileByRel = (rel: string | null) => page.story.local.files.find((file) => file.rel === rel);

async function toggleViewed(button: Element) {
  const section = button.closest('.ou-local-file') as Element; // the button is in its file's header
  const rel = section.getAttribute('data-path') as string;
  const nowViewed = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(nowViewed));
  section.classList.toggle('ou-local-folded', nowViewed);
  (section.querySelector('.ou-local-fold') as Element).setAttribute(
    'aria-expanded',
    String(!nowViewed),
  );
  section.querySelector('.ou-local-changed')?.remove();
  const file = fileByRel(rel);
  if (file) {
    file.viewed = nowViewed;
    file.viewed_changed = false;
  }
  try {
    await bridge.ask(ROUTES.viewed, { params: PARAMS, body: { path: rel, viewed: nowViewed } });
  } catch (err) {
    alert(`Couldn't save: ${(err as Error).message}`);
  }
  if (nowViewed && section.getBoundingClientRect().top < 0) {
    section.scrollIntoView();
  }
}

async function deleteNote(button: Element) {
  const id = button.getAttribute('data-note-delete') as string;
  try {
    await bridge.ask(ROUTES.noteUpdate, {
      params: { ...PARAMS, note: id },
      body: { delete: true },
    });
  } catch (err) {
    alert(`Couldn't delete the note: ${(err as Error).message}`);
    return;
  }
  page.story.local.notes = page.story.local.notes.filter((note) => note.id !== id);
  placeNotes();
}

function goToNote(link: Element) {
  const row = document.querySelector(
    `.ou-local-note-row[data-note="${CSS.escape(link.getAttribute('data-note-goto') as string)}"]`,
  );
  if (!row) {
    return;
  }
  (row.closest('.ou-local-file') as Element).classList.remove('ou-local-folded');
  if (row.classList.contains('ou-local-out')) {
    openFold(row);
  }
  window.scrollTo({
    top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3,
  });
}

// ---------- clicks on the diff: Viewed, fold, notes, tree (the panel handles its own)
document.addEventListener('click', async (event) => {
  const target = event.target as Element;
  if (target.closest('#once-upon-panel')) {
    return;
  }
  if (target.closest('.ou-local-pr')) {
    return openPrBox();
  }
  if (target.closest('.ou-local-push')) {
    return openPushBox();
  }
  if (target.closest('.ou-local-push-ahead')) {
    return openPushAheadBox();
  }
  if (target.closest('.ou-local-send')) {
    return sendNotes();
  }
  if (target.closest('.ou-local-approve')) {
    return toggleApprove(true);
  }
  if (target.closest('.ou-local-unapprove')) {
    return toggleApprove(false);
  }
  const viewedButton = target.closest('.ou-local-viewed');
  if (viewedButton) {
    return toggleViewed(viewedButton);
  }
  const view = target.closest('[data-diff-view]');
  if (view) {
    const want = view.getAttribute('data-diff-view');
    if (want !== page.story.local.diff_view) {
      setPref({ diffView: want === 'split' ? 'split' : 'unified' }, 'the diff view');
    }
    return;
  }
  const fold = target.closest('.ou-local-fold');
  if (fold) {
    const folded = (fold.closest('.ou-local-file') as Element).classList.toggle('ou-local-folded');
    fold.setAttribute('aria-expanded', String(!folded));
    return;
  }
  const treeFile = target.closest('[data-goto]');
  if (treeFile) {
    const file = fileByRel(treeFile.getAttribute('data-goto'));
    const el = file && document.getElementById(`diff-${file.sha}`);
    if (el) {
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 60 });
    }
    return;
  }
  const narrowButton = target.closest('[data-narrow-open]');
  if (narrowButton) {
    openRun(narrowButton.closest('tr') as HTMLTableRowElement);
    return;
  }
  const lineNumber = target.closest('td.ou-local-num[data-line-anchor]');
  if (lineNumber) {
    return openEditor(lineNumber);
  }
  const cancel = target.closest('[data-editor-cancel]');
  if (cancel) {
    (cancel.closest('tr') as HTMLTableRowElement).remove();
    return;
  }
  const deleteButton = target.closest('[data-note-delete]');
  if (deleteButton) {
    return deleteNote(deleteButton);
  }
  const noteLink = target.closest('[data-note-goto]');
  if (noteLink) {
    event.preventDefault();
    goToNote(noteLink);
    return;
  }
  const toggle = target.closest('.ou-local-notes-toggle');
  if (toggle) {
    const list = document.querySelector('.ou-local-notes-list') as HTMLElement;
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  }
});

/** Hide whitespace and Unified/Split: saved by the bridge for every story, then the diff is redrawn under the panel. */
async function setPref(
  patch: { diffView?: 'unified' | 'split'; hideWhitespace?: boolean },
  what: string,
) {
  try {
    await bridge.ask(ROUTES.storyPrefsWrite, { params: PARAMS, body: patch });
    page.story = (await bridge.ask(ROUTES.story, { params: PARAMS })) as LocalStoryData;
    render();
    remount();
  } catch (err) {
    alert(`Couldn't change ${what}: ${(err as Error).message}`);
    render();
  }
}

function setHideWhitespace(hide: boolean) {
  const box = document.querySelector<HTMLInputElement>('.ou-local-ws-toggle');
  if (box) {
    box.disabled = true;
  }
  return setPref({ hideWhitespace: hide }, 'Hide whitespace');
}

document.addEventListener('change', async (event) => {
  const target = event.target as Element;
  const whitespaceBox = target.closest<HTMLInputElement>('.ou-local-ws-toggle');
  if (whitespaceBox) {
    return setHideWhitespace(whitespaceBox.checked);
  }
  const box = target.closest<HTMLInputElement>('[data-note-done]');
  if (!box) {
    return;
  }
  const id = box.getAttribute('data-note-done') as string;
  const updated = (await bridge.ask(ROUTES.noteUpdate, {
    params: { ...PARAMS, note: id },
    body: { done: box.checked },
  })) as LocalNote;
  page.story.local.notes = page.story.local.notes.map((note) => (note.id === id ? updated : note));
  placeNotes();
});

// ---------- follow the story and the commits: when chapters.json changes or the head moves, redraw.
// The panel's pulse says when (mount.js), and this page polls /version itself only while the panel is closed.
async function reloadIfChanged(known?: string) {
  try {
    const version = known ?? (await bridge.ask(ROUTES.storyVersion, { params: PARAMS })).version;
    if (version === page.story.version) {
      return;
    }
    if (document.querySelector('.ou-local-note-edit')) {
      return; // don't redraw under a note being written
    }
    page.story = (await bridge.ask(ROUTES.story, { params: PARAMS })) as LocalStoryData;
    render();
    remount();
  } catch {
    /* bridge restarting */
  }
}

async function start() {
  page.hljs = await import('/assets/highlight.mjs').then(
    (module) => module.default,
    () => null,
  );
  try {
    page.story = (await bridge.ask(ROUTES.story, { params: PARAMS })) as LocalStoryData;
  } catch (err) {
    setHtml(
      app,
      html`<p class="ou-local-error">Couldn't load the story: ${(err as Error).message}</p>`,
    );
    return;
  }
  document.title = page.story.title;
  const [saved, prefs] = await Promise.all([
    bridge.ask(ROUTES.storyUiRead, { params: PARAMS }).catch(() => ({})) as Promise<InitialUi>,
    bridge.ask(ROUTES.storyPrefsRead, { params: PARAMS }).catch(() => null) as Promise<{
      layout?: Layout;
    } | null>,
  ]);
  // the story's own step and folds, at the size last dragged on any story
  page.layout = prefs?.layout || null;
  page.lastUi = withLayout(saved, page.layout);
  render();
  page.hidden = !!page.lastUi.hidden;
  if (page.hidden) {
    showReopen();
  } else {
    mount(page.lastUi);
  }
  window.__onceUponLocal = {
    get story() {
      return page.story;
    },
    get overlay() {
      return page.overlay;
    },
  };
  page.onVersion = reloadIfChanged;
  const pollWhileClosed = () => {
    if (page.hidden && document.visibilityState === 'visible') {
      reloadIfChanged();
    }
  };
  setInterval(pollWhileClosed, POLL_MS);
  window.addEventListener('focus', pollWhileClosed); // the panel's own tick looks on focus while it's open
  setInterval(() => {
    if (document.visibilityState !== 'visible') {
      bridge.ask(ROUTES.storySeen, { params: PARAMS }).catch(() => {});
    }
  }, STILL_OPEN_MS);
  lookForPull(true); // Create pull request turns into Open PR #N once the branch has one
  if (OPEN_PUSH) {
    // the board's Push: its link asks for the box (Push to the default branch, or Push for the open PR's branch)
    (page.story.local.ship === 'push' ? openPushBox : openPushAheadBox)();
  }
  window.addEventListener('focus', () => lookForPull());
}
start();
