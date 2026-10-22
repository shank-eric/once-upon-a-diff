/*
 * Fix-before-push notes: drawn under their line in the diff (or at the top
 * of the file when the diff doesn't draw that line), listed under the top
 * bar, and written in a small form opened from a line number. The panel's
 * Fix before push sends them to a Claude session; a sent note says where it
 * went and can't be deleted here.
 */
import { html } from '/assets/util/html.js';
import { insertHtml, setHtml } from '/assets/util/dom.js';
import { page, api, STORY_PATH } from './page.js';
import { columnCount } from './diff-view.js';

const placeOf = (note) =>
  `${note.path}${note.line ? `:${note.side === 'L' ? 'L' : ''}${note.line}` : ''}`;

/** Where a note has got, once the panel's Fix before push sent it: '' for a draft. */
function sentText(note) {
  if (note.fixed) {
    return `fixed in ${String(note.fixed.sha || '').slice(0, 7)}`;
  }
  return note.sent ? `sent to ${note.sent.to || 'the next Claude session'}` : '';
}

function notesListHtml() {
  const { notes } = page.story.local;
  if (!notes.length) {
    return html`<p class="ou-local-muted">No fix-before-push notes yet. Click a line number in the diff to add one.</p>`;
  }
  const items = notes.map((note) => {
    const sent = sentText(note) && html` <span class="ou-local-muted">(${sentText(note)})</span>`;
    const done = html`<input type="checkbox" data-note-done="${note.id}"${note.done && html` checked`}>`;
    const goto = html`<a href="#" data-note-goto="${note.id}"><code>${placeOf(note)}</code></a>`;
    return html`<li class="${note.done ? 'ou-local-done' : ''}"><label>${done} ${goto}</label> ${note.body}${sent}</li>`;
  });
  return html`<ul>${items}</ul>
    <p class="ou-local-muted">Send them to a Claude session from the panel's Fix before push. Also in the terminal: <code>once-upon notes --story ${page.story.id}</code></p>`;
}

function noteRow(note, away) {
  const awayNote =
    away &&
    html`<span class="ou-local-muted">on ${note.side === 'L' ? 'L' : ''}${note.line}, a line this diff doesn't draw${page.story.local.hide_whitespace && ' with whitespace hidden'}</span>`;
  const sentOrDelete = sentText(note)
    ? html`<span class="ou-local-muted">${sentText(note)}</span>`
    : html`<button type="button" data-note-delete="${note.id}">Delete</button>`;
  return html`<tr class="ou-local-note-row" data-note="${note.id}"><td colspan="${columnCount()}"><div class="ou-local-note${note.done && ' ou-local-done'}">
    <div class="ou-local-note-head"><b>Fix before push</b><span class="ou-local-muted">${new Date(note.at).toLocaleString()}</span>
      ${awayNote}
      <label><input type="checkbox" data-note-done="${note.id}"${note.done && html` checked`}> done</label>
      ${sentOrDelete}</div>
    <div class="ou-local-note-body">${note.body}</div></div></td></tr>`;
}

/** Draws every note in the diff and the list, and the open count on the toggle. */
export function placeNotes() {
  for (const el of document.querySelectorAll('.ou-local-note-row')) {
    el.remove();
  }
  const { local } = page.story;
  for (const note of local.notes) {
    const file = local.files.find((candidate) => candidate.rel === note.path);
    if (!file) {
      continue;
    }
    const cell =
      note.line &&
      document.querySelector(`[data-line-anchor="diff-${file.sha}${note.side}${note.line}"]`);
    const row = cell ? cell.closest('tr') : document.querySelector(`#diff-${file.sha} tbody tr`);
    if (row) {
      insertHtml(row, 'afterend', noteRow(note, !!note.line && !cell));
    }
  }
  const open = local.notes.filter((note) => !note.done).length;
  const toggle = document.querySelector('.ou-local-notes-toggle');
  if (toggle) {
    toggle.textContent = `Fix before push: ${open} open`;
  }
  const list = document.querySelector('.ou-local-notes-list');
  if (list) {
    setHtml(list, notesListHtml());
  }
}

/** The note form under a line, opened from its line number (focused again if it's already open). */
export function openEditor(cell) {
  const row = cell.closest('tr');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('ou-local-note-edit')) {
    return row.nextElementSibling.querySelector('textarea').focus();
  }
  const side = cell.getAttribute('data-side');
  const line = Number(cell.getAttribute('data-line'));
  const rel = cell.closest('.ou-local-file').getAttribute('data-path');
  insertHtml(
    row,
    'afterend',
    html`<tr class="ou-local-note-edit"><td colspan="${columnCount()}"><form class="ou-local-note-form">
    <div class="ou-local-muted">Fix before push on <code>${rel}:${side === 'L' ? 'L' : ''}${line}</code></div>
    <textarea rows="3" placeholder="What to fix before pushing"></textarea>
    <div><button type="submit">Add note</button> <button type="button" data-editor-cancel>Cancel</button></div></form></td></tr>`,
  );
  const form = row.nextElementSibling.querySelector('form');
  const textarea = form.querySelector('textarea');
  textarea.focus();
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = textarea.value.trim();
    if (!body) {
      return;
    }
    try {
      const note = await api('POST', `${STORY_PATH}/notes`, { path: rel, side, line, body });
      page.story.local.notes.push(note);
      form.closest('tr').remove();
      placeNotes();
      if (page.overlay) {
        page.overlay.refreshFixes(); // the panel's Fix before push lists it (and says if Auto-send sent it)
      }
    } catch (err) {
      alert(`Couldn't save the note: ${err.message}`);
    }
  });
}
