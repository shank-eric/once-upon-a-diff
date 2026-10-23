/*
 * Fix-before-push notes: drawn under their line in the diff (or at the top
 * of the file when the diff doesn't draw that line), listed under the top
 * bar, and written in a small form opened from a line number. The panel's
 * Fix before push sends them to a Claude session. Each note wears its stage
 * (To send, Queued, Sent, Fixed), the top bar's toggle counts them by stage,
 * and a sent note can't be deleted here.
 */
import { html } from '/assets/util/html.ts';
import { insertHtml, setHtml } from '/assets/util/dom.ts';
import { page, api, STORY_PATH } from './page.ts';
import { columnCount } from './diff-view.ts';
import type { LocalNote, Side } from '/assets/types.ts';

const placeOf = (note: LocalNote) =>
  `${note.path}${note.line ? `:${note.side === 'L' ? 'L' : ''}${note.line}` : ''}`;

/** Where a note has got: queued is sent with no session taking it yet, so the next one that listens gets it. */
type Stage = 'draft' | 'queued' | 'sent' | 'fixed';

const STAGE_LABELS: Record<Stage, string> = {
  draft: 'To send',
  queued: 'Queued',
  sent: 'Sent',
  fixed: 'Fixed',
};

function stageOf(note: LocalNote): Stage {
  if (note.fixed) {
    return 'fixed';
  }
  if (note.sent) {
    return note.sent.to ? 'sent' : 'queued';
  }
  return 'draft';
}

/** The stage in words, for after its label. */
function stageDetail(note: LocalNote): string {
  if (note.fixed) {
    return `in ${String(note.fixed.sha || '').slice(0, 7)}`;
  }
  if (note.sent) {
    return note.sent.to
      ? `to ${note.sent.to}`
      : 'for the next Claude session that listens on this story';
  }
  if (note.returned) {
    return `came back${note.returned.why ? `: ${note.returned.why}` : ''}`;
  }
  return '';
}

function stageHtml(note: LocalNote) {
  const stage = stageOf(note);
  const detail = stageDetail(note);
  return html`<span class="ou-local-stage ou-local-stage-${stage}">${STAGE_LABELS[stage]}</span>${detail && html` <span class="ou-local-muted">${detail}</span>`}`;
}

/** The toggle's count of the notes not ticked done, by stage: "Fix before push: 1 queued", "2 to send, 1 sent". */
export function toggleText(notes: LocalNote[]): string {
  const open = notes.filter((note) => !note.done);
  if (!open.length) {
    return `Fix before push: ${notes.length ? 'all done' : 'none'}`;
  }
  const counts = (['draft', 'queued', 'sent', 'fixed'] as Stage[])
    .map((stage) => {
      const count = open.filter((note) => stageOf(note) === stage).length;
      return count ? `${count} ${STAGE_LABELS[stage].toLowerCase()}` : '';
    })
    .filter(Boolean);
  return `Fix before push: ${counts.join(', ')}`;
}

function notesListHtml() {
  const { notes } = page.story.local;
  if (!notes.length) {
    return html`<p class="ou-local-muted">No fix-before-push notes yet. Click a line number in the diff to add one.</p>`;
  }
  const items = notes.map((note) => {
    const done = html`<input type="checkbox" data-note-done="${note.id}"${note.done && html` checked`}>`;
    const goto = html`<a href="#" data-note-goto="${note.id}"><code>${placeOf(note)}</code></a>`;
    return html`<li class="${note.done ? 'ou-local-done' : ''}"><label>${done} ${goto}</label> ${stageHtml(note)}<div class="ou-local-note-text">${note.body}</div></li>`;
  });
  return html`<ul>${items}</ul>
    <p class="ou-local-muted">Send them to a Claude session from the panel's Fix before push. Also in the terminal: <code>once-upon notes --story ${page.story.id}</code></p>`;
}

function noteRow(note: LocalNote, away: boolean) {
  const awayNote =
    away &&
    html`<span class="ou-local-muted">on ${note.side === 'L' ? 'L' : ''}${note.line}, a line this diff doesn't draw${page.story.local.hide_whitespace && ' with whitespace hidden'}</span>`;
  const deleteButton =
    !note.sent &&
    !note.fixed &&
    html`<button type="button" data-note-delete="${note.id}">Delete</button>`;
  return html`<tr class="ou-local-note-row" data-note="${note.id}"><td colspan="${columnCount()}"><div class="ou-local-note${note.done && ' ou-local-done'}">
    <div class="ou-local-note-head"><b>Fix before push</b><span class="ou-local-muted">${new Date(note.at).toLocaleString()}</span>
      ${awayNote}
      <label><input type="checkbox" data-note-done="${note.id}"${note.done && html` checked`}> done</label>
      ${stageHtml(note)}${deleteButton}</div>
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
  const toggle = document.querySelector('.ou-local-notes-toggle');
  if (toggle) {
    toggle.textContent = toggleText(local.notes);
  }
  const list = document.querySelector('.ou-local-notes-list');
  if (list) {
    setHtml(list, notesListHtml());
  }
}

/** The note form under a line, opened from its line number (focused again if it's already open). */
export function openEditor(cell: Element) {
  // a line number cell, in its row, in its file's section
  const row = cell.closest('tr') as HTMLTableRowElement;
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('ou-local-note-edit')) {
    return (row.nextElementSibling.querySelector('textarea') as HTMLTextAreaElement).focus();
  }
  const side = cell.getAttribute('data-side') as Side;
  const line = Number(cell.getAttribute('data-line'));
  const rel = (cell.closest('.ou-local-file') as Element).getAttribute('data-path') as string;
  insertHtml(
    row,
    'afterend',
    html`<tr class="ou-local-note-edit"><td colspan="${columnCount()}"><form class="ou-local-note-form">
    <div class="ou-local-muted">Fix before push on <code>${rel}:${side === 'L' ? 'L' : ''}${line}</code></div>
    <textarea rows="3" placeholder="What to fix before pushing"></textarea>
    <div><button type="submit">Add note</button> <button type="button" data-editor-cancel>Cancel</button></div></form></td></tr>`,
  );
  // the form just inserted after the row
  const form = (row.nextElementSibling as Element).querySelector('form') as HTMLFormElement;
  const textarea = form.querySelector('textarea') as HTMLTextAreaElement;
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
      const note = await api<LocalNote>('POST', `${STORY_PATH}/notes`, {
        path: rel,
        side,
        line,
        body,
      });
      page.story.local.notes.push(note);
      (form.closest('tr') as HTMLTableRowElement).remove();
      placeNotes();
      if (page.overlay) {
        page.overlay.refreshFixes(); // the panel's Fix before push lists it (and says if Auto-send sent it)
      }
    } catch (err) {
      alert(`Couldn't save the note: ${(err as Error).message}`);
    }
  });
}
