/*
 * Fix before push: the story's notes, which collect as drafts (Add to fix before push on a drafted comment, or a
 * line note on the local page) until Send N notes to <session> hands them to a Claude session as one fix request.
 * A draft note can be edited or removed. A sent one shows "Sent to <session>", then "Fixed in <sha>" when the
 * session reports back, or comes back as a draft with why. Auto-send (per story, off by default) sends each note as
 * it's added, and a request nobody has reported on can be taken back. opts.fixes talks to the bridge:
 * {load(), act(body), note(id, changes), onChange(view)}.
 *
 * The Overview lists every note; a chapter lists the notes on its files, with the same Send for the whole batch.
 *
 * fixSummary has no DOM, so node tests can use it.
 */
import { html } from '../util/html.ts';
import { setHtml } from '../util/dom.ts';
import { plural, shortSha } from '../util/text.ts';
import { shortDateTime } from '../util/time.ts';
import { refAttrs } from './file-refs.ts';
import type { PanelContext } from './context.ts';
import type { FixNote, FixesView } from '../types.ts';

type FixSummary = { drafts: number; send: string | null; counts: string };

/** {drafts, send, counts}: how many notes a send takes, its button's label (null with none), and the tally. */
export function fixSummary({ notes, to }: Pick<FixesView, 'notes' | 'to'>): FixSummary {
  const count = (state: FixNote['state']) => notes.filter((note) => note.state === state).length;
  const drafts = count('draft');
  const sent = count('sent');
  const fixed = count('fixed');
  return {
    drafts,
    send: drafts ? `Send ${plural(drafts, 'note')}${to ? ` to ${to.consumer}` : ''}` : null,
    counts: [drafts && `${drafts} to send`, sent && `${sent} sent`, fixed && `${fixed} fixed`]
      .filter(Boolean)
      .join(' · '),
  };
}

const AUTO_TITLE =
  'Sends each note to the Claude session as soon as it is added, instead of waiting for Send. Kept for this story. ' +
  'A note from a drafted comment waits for Send, since Claude wrote it from the PR.';
const SEND_TITLE =
  'Hands every draft note to the Claude session as one request: it makes one change for them, commits it ' +
  'as your repo rules say and never pushes. Sent notes are locked until it reports back.';
const TAKE_BACK_TITLE = 'Brings these notes back as drafts, to edit or send again';

export function createFixes(context: PanelContext) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let view: FixesView | null = null; // the bridge's {notes, auto_send, to, requests}
  let editing: string | null = null; // the id of the note whose text is being edited
  let busy = false;

  /** The notes this step lists: every one on the Overview, else the ones on the chapter's files. */
  function shownNotes(): FixNote[] {
    if (!view) {
      return [];
    }
    if (!state.n) {
      return view.notes;
    }
    const files = context.inChapter();
    return view.notes.filter((note) => files.has(note.path));
  }

  function placeHtml(note: FixNote) {
    const line = Number(note.line) > 0 ? note.line : null;
    const where = `${note.path}${line ? `:${note.side === 'L' ? 'L' : ''}${line}` : ''}`;
    const attrs = line
      ? refAttrs(note.path, { side: note.side === 'L' ? 'L' : 'R', start: line, end: line })
      : refAttrs(note.path, null);
    return html`<code ${attrs}>${where}</code>`;
  }

  /** Where the note has got, under its text. */
  function stateHtml(note: FixNote) {
    // a note is fixed when it has `fixed`, sent when it has `sent`
    if (note.state === 'fixed') {
      const fixer = note.fixed!.by && ` by ${note.fixed!.by}`;
      return html`<span class="ou-ok">Fixed in ${shortSha(note.fixed!.sha)} ✓</span>${fixer}`;
    }
    if (note.state === 'sent') {
      const sentTo = note.sent!.to || 'the next Claude session that listens';
      return html`<span class="ou-pend">Sent to ${sentTo}</span> · ${shortDateTime(note.sent!.at)}`;
    }
    if (note.returned) {
      const from = note.returned.sha && ` from ${shortSha(note.returned.sha)}`;
      return html`<span class="ou-cstale">Back${from}: ${note.returned.why || ''}</span>`;
    }
    const waits =
      note.draft &&
      view &&
      view.auto_send &&
      ': Auto-send leaves notes from drafted comments to Send';
    return html`<span class="ou-cdraft">Draft</span>, not sent${waits}`;
  }

  function noteHtml(note: FixNote) {
    const draft = note.state === 'draft';
    const buttons =
      draft &&
      html`<button data-fix-act="edit">Edit</button><button data-fix-act="remove">Remove</button>`;
    const text =
      editing === note.id
        ? html`<textarea class="ou-fixedit" rows="3">${note.body}</textarea><div class="ou-fixeditbtns"><button data-fix-act="save">Save</button> <button data-fix-act="cancel">Cancel</button></div>`
        : html`<pre>${note.body}</pre>`;
    const head = html`<div class="ou-where"><span>${placeHtml(note)}</span><span class="ou-cbtns">${buttons}</span></div>`;
    return html`<div class="ou-comment ou-fixnote ou-fx-${note.state}" data-note-id="${note.id}">${head}${text}<div class="ou-cstate">${stateHtml(note)}</div></div>`;
  }

  /** Send, Auto-send, and Take back for each request still with a session. */
  function toolsHtml(summary: FixSummary) {
    // drawn only with the bridge's view
    const send =
      summary.send &&
      html`<button data-fix-act="send" title="${SEND_TITLE}">${summary.send}</button>`;
    const auto = html`<label class="ou-fixauto" title="${AUTO_TITLE}"><input type="checkbox" data-fix-act="auto"${view!.auto_send && html` checked`}> Auto-send</label>`;
    const takeBack = view!.requests
      .filter((request) => request.status === 'pending')
      .map((request) => {
        const notes = plural(request.notes.length, 'note');
        const sentTo = request.claimed_by || request.to || 'the next session';
        return html` <button class="ou-linkish" data-fix-act="take_back" data-request="${request.id}" title="${TAKE_BACK_TITLE}">Take back the ${notes} sent to ${sentTo}</button>`;
      });
    const nobody =
      summary.send &&
      !view!.to &&
      html`<div class="ou-quiet">No Claude session takes fix requests for this story yet: a send waits for the next one.</div>`;
    return html`<div class="ou-fixtools">${send}${auto}${takeBack}</div>${nobody}`;
  }

  function render() {
    const box = $('.ou-fixes');
    if (!box) {
      return;
    }
    if (!view || (!view.notes.length && !view.auto_send)) {
      setHtml(box, '');
      return;
    }
    // a redraw while a note is being edited keeps what was typed
    const typing = box.querySelector<HTMLTextAreaElement>('.ou-fixedit');
    const typed = typing ? typing.value : null;
    const summary = fixSummary(view);
    const notes = shownNotes();
    const elsewhere = view.notes.length - notes.length;
    const more =
      elsewhere > 0 &&
      html`<div class="ou-quiet">${plural(elsewhere, 'more note')} on other chapters' files (all on the Overview).</div>`;
    const counts = summary.counts && `(${summary.counts})`;
    setHtml(
      box,
      html`<h2 class="ou-h">Fix before push (${view.notes.length}) <span class="ou-draftsum">${counts}</span></h2>${toolsHtml(summary)}${notes.map(noteHtml)}${more}`,
    );
    const textarea = box.querySelector<HTMLTextAreaElement>('.ou-fixedit');
    if (textarea) {
      if (typed !== null) {
        textarea.value = typed;
      } else {
        textarea.focus(); // just opened
      }
    }
  }

  /** Takes the bridge's view, redraws, and tells the host (the local page re-places its notes) and the drafts. */
  function take(next: FixesView | null | undefined) {
    if (!next || !Array.isArray(next.notes)) {
      return;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    if (!changed) {
      return;
    }
    render();
    if (opts.fixes!.onChange) {
      opts.fixes!.onChange(view); // the bridge's view only comes through opts.fixes
    }
    context.drafts.refresh(true);
  }

  async function refresh() {
    if (!opts.fixes) {
      return;
    }
    try {
      take(await opts.fixes.load());
    } catch {
      /* the bridge may be down; the next pulse looks again */
    }
  }

  /** A click on a [data-fix-act] control (the body's click handler sends it here). */
  async function act(control: HTMLButtonElement | HTMLInputElement) {
    const action = control.getAttribute('data-fix-act');
    const item = control.closest('[data-note-id]');
    const noteId = item ? item.getAttribute('data-note-id') : null;
    if (action === 'edit' || action === 'cancel') {
      editing = action === 'edit' ? noteId : null;
      render();
      return;
    }
    if (busy || !opts.fixes) {
      return;
    }
    busy = true;
    control.disabled = true;
    try {
      if (action === 'send') {
        const next = await opts.fixes.act({ action: 'send' });
        shell.message(
          next.sent && next.sent.to
            ? `Sent to ${next.sent.to}. Its notes are locked until it reports back.`
            : 'Queued: the next Claude session that takes fix requests for this story gets it.',
        );
        take(next);
      } else if (action === 'auto') {
        take(await opts.fixes.act({ action: 'auto', on: (control as HTMLInputElement).checked }));
      } else if (action === 'take_back') {
        take(
          await opts.fixes.act({
            action: 'take_back',
            request: control.getAttribute('data-request'),
          }),
        );
      } else if (action === 'remove') {
        await opts.fixes.note(noteId, { delete: true });
        await refresh();
      } else if (action === 'save') {
        const text = item!.querySelector<HTMLTextAreaElement>('.ou-fixedit')!.value.trim(); // Save is on a note
        if (text) {
          await opts.fixes.note(noteId, { body: text });
        }
        editing = null;
        await refresh();
        render();
      }
    } catch (err) {
      shell.message(
        `Couldn't save that: ${err && (err as Error).message ? (err as Error).message : err}`,
      );
      await refresh();
    } finally {
      busy = false;
      control.disabled = false;
    }
  }

  refresh();

  return { render, refresh, act };
}

export type Fixes = ReturnType<typeof createFixes>;
