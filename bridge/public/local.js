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
import { escapeHtml } from '/assets/util/html.js';
import { page, api, STORY_PATH } from '/assets/local/page.js';
import { treeHtml, fileHtml, headerHtml, resetHighlightBudget } from '/assets/local/diff-view.js';
import { placeNotes, openEditor } from '/assets/local/notes.js';
import { openFold, openRun, forgetNarrowing } from '/assets/local/folds.js';
import { mount, remount, showReopen } from '/assets/local/mount.js';

const POLL_MS = 5000;
const app = document.getElementById('ds-app');

function render() {
  const keep = window.scrollY;
  forgetNarrowing();
  resetHighlightBudget();
  const { files } = page.story.local;
  app.innerHTML = `${headerHtml()}<div class="ds-layout"><nav class="ds-tree" role="tree" aria-label="Changed files">${treeHtml(files.map((file) => file.rel))}</nav>
    <main class="ds-files">${files.map(fileHtml).join('')}</main></div>`;
  placeNotes();
  window.scrollTo({ top: keep });
}

const fileByRel = (rel) => page.story.local.files.find((file) => file.rel === rel);

async function toggleViewed(button) {
  const section = button.closest('.ds-file');
  const rel = section.getAttribute('data-path');
  const nowViewed = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(nowViewed));
  section.classList.toggle('ds-folded', nowViewed);
  section.querySelector('.ds-fold').setAttribute('aria-expanded', String(!nowViewed));
  section.querySelector('.ds-changed')?.remove();
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
  await api('POST', `${STORY_PATH}/notes/${encodeURIComponent(id)}`, { delete: true });
  page.story.local.notes = page.story.local.notes.filter((note) => note.id !== id);
  placeNotes();
}

function goToNote(link) {
  const row = document.querySelector(
    `.ds-note-row[data-note="${CSS.escape(link.getAttribute('data-note-goto'))}"]`,
  );
  if (!row) {
    return;
  }
  row.closest('.ds-file').classList.remove('ds-folded');
  if (row.classList.contains('ds-out')) {
    openFold(row);
  }
  window.scrollTo({
    top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3,
  });
}

// ---------- clicks on the diff: Viewed, fold, notes, tree (the panel handles its own)
document.addEventListener('click', async (event) => {
  const target = /** @type {Element} */ (event.target);
  if (target.closest('#diff-story-panel')) {
    return;
  }
  const viewedButton = target.closest('.ds-viewed');
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
  const fold = target.closest('.ds-fold');
  if (fold) {
    const folded = fold.closest('.ds-file').classList.toggle('ds-folded');
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
  const lineNumber = target.closest('td.ds-num[data-line-anchor]');
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
  const toggle = target.closest('.ds-notes-toggle');
  if (toggle) {
    const list = /** @type {HTMLElement} */ (document.querySelector('.ds-notes-list'));
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
  const box = /** @type {HTMLInputElement|null} */ (document.querySelector('.ds-ws-toggle'));
  if (box) {
    box.disabled = true;
  }
  return setPref({ hideWhitespace: hide }, 'Hide whitespace');
}

document.addEventListener('change', async (event) => {
  const target = /** @type {Element} */ (event.target);
  const whitespaceBox = /** @type {HTMLInputElement|null} */ (target.closest('.ds-ws-toggle'));
  if (whitespaceBox) {
    return setHideWhitespace(whitespaceBox.checked);
  }
  const box = /** @type {HTMLInputElement|null} */ (target.closest('[data-note-done]'));
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
    if (document.querySelector('.ds-note-edit')) {
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
    app.innerHTML = `<p class="ds-error">Couldn't load the story: ${escapeHtml(err.message)}</p>`;
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
  window.__diffStoryLocal = {
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
