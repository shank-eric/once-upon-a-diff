/*
 * Fix-before-push notes: drawn under their line in the diff (or at the top
 * of the file when the diff doesn't draw that line), listed under the top
 * bar, and written in a small form opened from a line number.
 */
import { escapeHtml } from '/assets/util/html.js';
import { page, api, STORY_PATH } from './page.js';
import { columnCount } from './diff-view.js';

const placeOf = (note) =>
  `${note.path}${note.line ? `:${note.side === 'L' ? 'L' : ''}${note.line}` : ''}`;

function notesListHtml() {
  const { notes } = page.story.local;
  if (!notes.length) {
    return '<p class="ds-muted">No fix-before-push notes yet. Click a line number in the diff to add one.</p>';
  }
  const items = notes
    .map(
      (note) =>
        `<li class="${note.done ? 'ds-done' : ''}"><label>` +
        `<input type="checkbox" data-note-done="${escapeHtml(note.id)}"${note.done ? ' checked' : ''}> ` +
        `<a href="#" data-note-goto="${escapeHtml(note.id)}"><code>${escapeHtml(placeOf(note))}</code></a></label> ` +
        `${escapeHtml(note.body)}</li>`,
    )
    .join('');
  return `<ul>${items}</ul>
    <p class="ds-muted">Also in the terminal: <code>once-upon notes --story ${escapeHtml(page.story.id)}</code></p>`;
}

function noteRow(note, away) {
  const awayNote = away
    ? `<span class="ds-muted">on ${note.side === 'L' ? 'L' : ''}${note.line}, a line this diff doesn't draw${page.story.local.hide_whitespace ? ' with whitespace hidden' : ''}</span>`
    : '';
  return `<tr class="ds-note-row" data-note="${escapeHtml(note.id)}"><td colspan="${columnCount()}"><div class="ds-note${note.done ? ' ds-done' : ''}">
    <div class="ds-note-head"><b>Fix before push</b><span class="ds-muted">${escapeHtml(new Date(note.at).toLocaleString())}</span>
      ${awayNote}
      <label><input type="checkbox" data-note-done="${escapeHtml(note.id)}"${note.done ? ' checked' : ''}> done</label>
      <button type="button" data-note-delete="${escapeHtml(note.id)}">Delete</button></div>
    <div class="ds-note-body">${escapeHtml(note.body)}</div></div></td></tr>`;
}

/** Draws every note in the diff and the list, and the open count on the toggle. */
export function placeNotes() {
  for (const el of document.querySelectorAll('.ds-note-row')) {
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
      row.insertAdjacentHTML('afterend', noteRow(note, !!note.line && !cell));
    }
  }
  const open = local.notes.filter((note) => !note.done).length;
  const toggle = document.querySelector('.ds-notes-toggle');
  if (toggle) {
    toggle.textContent = `Fix before push: ${open} open`;
  }
  const list = document.querySelector('.ds-notes-list');
  if (list) {
    list.innerHTML = notesListHtml();
  }
}

/** The note form under a line, opened from its line number (focused again if it's already open). */
export function openEditor(cell) {
  const row = cell.closest('tr');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('ds-note-edit')) {
    return row.nextElementSibling.querySelector('textarea').focus();
  }
  const side = cell.getAttribute('data-side');
  const line = Number(cell.getAttribute('data-line'));
  const rel = cell.closest('.ds-file').getAttribute('data-path');
  row.insertAdjacentHTML(
    'afterend',
    `<tr class="ds-note-edit"><td colspan="${columnCount()}"><form class="ds-note-form">
    <div class="ds-muted">Fix before push on <code>${escapeHtml(rel)}:${side === 'L' ? 'L' : ''}${line}</code></div>
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
    } catch (err) {
      alert(`Couldn't save the note: ${err.message}`);
    }
  });
}
