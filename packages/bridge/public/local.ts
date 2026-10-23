// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The bridge's local page: a diff of local commits drawn with the same DOM
 * shapes as GitHub's /changes page (local/diff-view.js), so the very same
 * story panel runs on it unchanged (local/mount.js).
 *
 * Here the page owns the review state that GitHub would own: Viewed toggles
 * and line notes go to the bridge, and notes are "fix before push" items
 * (local/notes.js). Other chapters' lines in a shared file fold away
 * (local/folds.js). This module draws the page, handles its clicks, and
 * follows the story and the commits.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { page, api, STORY_PATH } from '/assets/local/page.ts';
import { treeHtml, fileHtml, headerHtml, resetHighlightBudget } from '/assets/local/diff-view.ts';
import { placeNotes, openEditor } from '/assets/local/notes.ts';
import { openFold, openRun, forgetNarrowing } from '/assets/local/folds.ts';
import { mount, remount, showReopen } from '/assets/local/mount.ts';

const POLL_MS = 5000;
const app = document.getElementById('ou-local-app');

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

const fileByRel = (rel) => page.story.local.files.find((file) => file.rel === rel);

async function toggleViewed(button) {
  const section = button.closest('.ou-local-file');
  const rel = section.getAttribute('data-path');
  const nowViewed = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(nowViewed));
  section.classList.toggle('ou-local-folded', nowViewed);
  section.querySelector('.ou-local-fold').setAttribute('aria-expanded', String(!nowViewed));
  section.querySelector('.ou-local-changed')?.remove();
  const file = fileByRel(rel);
  if (file) {
    file.viewed = nowViewed;
    file.viewed_changed = false;
  }
  try {
    await api('POST', `${STORY_PATH}/viewed`, { path: rel, viewed: nowViewed });
  } catch (err) {
    alert(`Couldn't save: ${err.message}`);
  }
  if (nowViewed && section.getBoundingClientRect().top < 0) {
    section.scrollIntoView();
  }
}

async function deleteNote(button) {
  const id = button.getAttribute('data-note-delete');
  try {
    await api('POST', `${STORY_PATH}/notes/${encodeURIComponent(id)}`, { delete: true });
  } catch (err) {
    alert(`Couldn't delete the note: ${err.message}`);
    return;
  }
  page.story.local.notes = page.story.local.notes.filter((note) => note.id !== id);
  placeNotes();
}

function goToNote(link) {
  const row = document.querySelector(
    `.ou-local-note-row[data-note="${CSS.escape(link.getAttribute('data-note-goto'))}"]`,
  );
  if (!row) {
    return;
  }
  row.closest('.ou-local-file').classList.remove('ou-local-folded');
  if (row.classList.contains('ou-local-out')) {
    openFold(row);
  }
  window.scrollTo({
    top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3,
  });
}

// ---------- clicks on the diff: Viewed, fold, notes, tree (the panel handles its own)
document.addEventListener('click', async (event) => {
  const target = /** @type {Element} */ event.target;
  if (target.closest('#once-upon-panel')) {
    return;
  }
  const viewedButton = target.closest('.ou-local-viewed');
  if (viewedButton) {
    return toggleViewed(viewedButton);
  }
  const view = target.closest('[data-diff-view]');
  if (view) {
    const want = view.getAttribute('data-diff-view');
    if (want !== page.story.local.diff_view) {
      setPref({ diffView: want }, 'the diff view');
    }
    return;
  }
  const fold = target.closest('.ou-local-fold');
  if (fold) {
    const folded = fold.closest('.ou-local-file').classList.toggle('ou-local-folded');
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
    openRun(narrowButton.closest('tr'));
    return;
  }
  const lineNumber = target.closest('td.ou-local-num[data-line-anchor]');
  if (lineNumber) {
    return openEditor(lineNumber);
  }
  const cancel = target.closest('[data-editor-cancel]');
  if (cancel) {
    cancel.closest('tr').remove();
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
    const list = /** @type {HTMLElement} */ document.querySelector('.ou-local-notes-list');
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  }
});

/** Hide whitespace and Unified/Split: saved by the bridge for every story, then the diff is redrawn under the panel. */
async function setPref(patch, what) {
  try {
    await api('POST', '/api/prefs', patch);
    page.story = await api('GET', STORY_PATH);
    render();
    remount();
  } catch (err) {
    alert(`Couldn't change ${what}: ${err.message}`);
    render();
  }
}

function setHideWhitespace(hide) {
  const box = /** @type {HTMLInputElement|null} */ document.querySelector('.ou-local-ws-toggle');
  if (box) {
    box.disabled = true;
  }
  return setPref({ hideWhitespace: hide }, 'Hide whitespace');
}

document.addEventListener('change', async (event) => {
  const target = /** @type {Element} */ event.target;
  const whitespaceBox = /** @type {HTMLInputElement|null} */ target.closest('.ou-local-ws-toggle');
  if (whitespaceBox) {
    return setHideWhitespace(whitespaceBox.checked);
  }
  const box = /** @type {HTMLInputElement|null} */ target.closest('[data-note-done]');
  if (!box) {
    return;
  }
  const id = box.getAttribute('data-note-done');
  const updated = await api('POST', `${STORY_PATH}/notes/${encodeURIComponent(id)}`, {
    done: box.checked,
  });
  page.story.local.notes = page.story.local.notes.map((note) => (note.id === id ? updated : note));
  placeNotes();
});

// ---------- follow the story and the commits: when chapters.json changes or the head moves, redraw.
// The panel's pulse says when (mount.js), and this page polls /version itself only while the panel is closed.
async function reloadIfChanged(known) {
  try {
    const version = known ?? (await api('GET', `${STORY_PATH}/version`)).version;
    if (version === page.story.version) {
      return;
    }
    if (document.querySelector('.ou-local-note-edit')) {
      return; // don't redraw under a note being written
    }
    page.story = await api('GET', STORY_PATH);
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
    page.story = await api('GET', STORY_PATH);
  } catch (err) {
    setHtml(app, html`<p class="ou-local-error">Couldn't load the story: ${err.message}</p>`);
    return;
  }
  document.title = page.story.title;
  page.lastUi = await api('GET', `${STORY_PATH}/ui`).catch(() => ({}));
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
}
start();
