/*
 * Fix-before-push notes: drawn under their line in the diff (or at the top of the file when the diff doesn't draw that line),
 * listed under the top bar, and written in a small form opened from a line number. The panel's Fix before push sends them to a
 * Claude session. Each note wears its stage (To send, Queued, Sent, Fixed), the top bar's toggle counts them by stage, and a
 * sent note can't be deleted here.
 */
import { html, useLayoutEffect, useRef } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import { page, bridge, PARAMS } from '/assets/local/page.ts';
import { closeEditor, deleteNote, gotoNote, setDone, upsertNote } from '/assets/local/actions.ts';
import { columnCount, type EditorRow, type NoteRow } from './rows.ts';
import type { LocalNote } from '/assets/types.ts';
import { fixStage, type FixStage } from '/assets/domain/fix-notes.ts';
import { formatLineRef } from '/assets/domain/line-refs.ts';
import { shortSha } from '/assets/domain/text.ts';

const placeOf = (note: LocalNote) =>
  note.line ? formatLineRef(note.path, { side: note.side, start: note.line }) : note.path;

const STAGE_LABELS: Record<FixStage, string> = {
  draft: 'To send',
  queued: 'Queued',
  sent: 'Sent',
  fixed: 'Fixed',
};

/** The stage in words, for after its label. */
function stageDetail(note: LocalNote): string {
  if (note.fixed) {
    return `in ${shortSha(note.fixed.sha)}`;
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

function Stage(props: { note: LocalNote }) {
  const stage = fixStage(props.note);
  const detail = stageDetail(props.note);
  return html`<span class="ou-local-stage ou-local-stage-${stage}">${STAGE_LABELS[stage]}</span>${detail && html` <span class="ou-local-muted">${detail}</span>`}`;
}

/** The toggle's count of the notes not ticked done, by stage: "Fix before push: 1 queued", "2 to send, 1 sent". */
export function toggleText(notes: LocalNote[]): string {
  const open = notes.filter((note) => !note.done);
  if (!open.length) {
    return `Fix before push: ${notes.length ? 'all done' : 'none'}`;
  }
  const counts = (['draft', 'queued', 'sent', 'fixed'] as FixStage[])
    .map((stage) => {
      const count = open.filter((note) => fixStage(note) === stage).length;
      return count ? `${count} ${STAGE_LABELS[stage].toLowerCase()}` : '';
    })
    .filter(Boolean);
  return `Fix before push: ${counts.join(', ')}`;
}

const DoneBox = (props: { note: LocalNote }) =>
  html`<input type="checkbox" data-note-done=${props.note.id} checked=${!!props.note.done} onChange=${(event: Event) => setDone(props.note.id, (event.currentTarget as HTMLInputElement).checked)} />`;

/** The list under the top bar. */
export function NotesList(props: { notes: LocalNote[]; storyId: string; open: boolean }) {
  const { notes, storyId, open } = props;
  const body = notes.length
    ? html`<ul>${notes.map(
        (note) =>
          html`<li key=${note.id} class=${note.done ? 'ou-local-done' : ''}><label><${DoneBox} note=${note} /> <a href="#" data-note-goto=${note.id} onClick=${(
            event: Event,
          ) => {
            event.preventDefault();
            gotoNote(note.id);
          }}><code>${placeOf(note)}</code></a></label> <${Stage} note=${note} /><div class="ou-local-note-text">${note.body}</div></li>`,
      )}</ul>
      <p class="ou-local-muted">Send them to a Claude session with Send above, or from the panel's Fix before push. Also in the terminal: <code>once-upon notes --story ${storyId}</code></p>`
    : html`<p class="ou-local-muted">No fix-before-push notes yet. Click a line number in the diff to add one.</p>`;
  return html`<section class="ou-local-notes-list" hidden=${!open}>${body}</section>`;
}

/** A note, in the diff under its line. */
export function NoteRowView(props: { row: NoteRow; split: boolean; hideWhitespace: boolean }) {
  const { note, away } = props.row;
  const awayNote =
    away &&
    html`<span class="ou-local-muted">on ${note.side === 'L' ? 'L' : ''}${note.line}, a line this diff doesn't draw${props.hideWhitespace && ' with whitespace hidden'}</span>`;
  const deleteButton =
    !note.sent &&
    !note.fixed &&
    html`<button type="button" data-note-delete=${note.id} onClick=${() => deleteNote(note.id)}>Delete</button>`;
  return html`<tr class="ou-local-note-row" data-note=${note.id}><td colspan=${columnCount(props.split)}><div class=${note.done ? 'ou-local-note ou-local-done' : 'ou-local-note'}>
    <div class="ou-local-note-head"><b>Fix before push</b><span class="ou-local-muted">${new Date(note.at).toLocaleString()}</span>
      ${awayNote}
      <label><${DoneBox} note=${note} /> done</label>
      <${Stage} note=${note} />${deleteButton}</div>
    <div class="ou-local-note-body">${note.body}</div></div></td></tr>`;
}

/**
 * The note form under a line, opened from its line number. An empty note does nothing, a failure says so and leaves the form
 * open, and a saved note joins the diff and the panel's Fix before push list (which says if Auto-send sent it).
 */
export function EditorRowView(props: { row: EditorRow; split: boolean }) {
  const { editor } = props.row;
  const box = useRef<HTMLTextAreaElement | null>(null);
  // focused when the form opens, and again each time its line number is clicked
  useLayoutEffect(() => box.current?.focus(), [editor.focus]);
  const submit = async (event: Event) => {
    event.preventDefault();
    const body = (box.current as HTMLTextAreaElement).value.trim();
    if (!body) {
      return;
    }
    try {
      const note = (await bridge.ask(ROUTES.noteAdd, {
        params: PARAMS,
        body: { path: editor.rel, side: editor.side, line: editor.line, body },
      })) as LocalNote;
      upsertNote(note);
      closeEditor(editor.key);
      if (page.overlay) {
        page.overlay.refreshFixes(); // the panel's Fix before push lists it (and says if Auto-send sent it)
      }
    } catch (err) {
      alert(`Couldn't save the note: ${(err as Error).message}`);
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
    }
  };
  return html`<tr class="ou-local-note-edit"><td colspan=${columnCount(props.split)}><form class="ou-local-note-form" onSubmit=${submit}>
    <div class="ou-local-muted">Fix before push on <code>${formatLineRef(editor.rel, { side: editor.side, start: editor.line })}</code></div>
    <textarea ref=${box} rows="3" placeholder="What to fix before pushing" onKeyDown=${keydown}></textarea>
    <div><button type="submit">Add note</button> <button type="button" data-editor-cancel onClick=${() => closeEditor(editor.key)}>Cancel</button></div></form></td></tr>`;
}
