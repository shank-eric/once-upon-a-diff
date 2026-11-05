/*
 * Fix before push, drawn: the heading with its counts, Send, Auto-send and Take back, and the notes with their editor (see fixes.ts
 * for what the notes are and the summary). Each control has its own handler; the one that is out is off meanwhile (`busyKey`). A
 * note being edited is a keyed component, so what is typed stays through a redraw and is lost on a step change, as it always was.
 */
import { html, useLayoutEffect, useRef } from '/assets/preact.mjs';
import { LinkButton } from '@once-upon-a-diff/ui-kit/components/link-button';
import { plural, shortSha } from '@once-upon-a-diff/domain/text';
import { shortDateTime } from '@once-upon-a-diff/domain/time';
import { fixSummary, takesNotes } from './fixes.ts';
import type { FixSummary } from './fixes.ts';
import type { PanelContext } from '../host/context.ts';
import type { FixNote, FixesView } from '@once-upon-a-diff/contracts/types';
import { formatLineRef, toSide } from '@once-upon-a-diff/domain/line-refs';

const AUTO_TITLE =
  'Sends each note to the Claude session as soon as it is added, instead of waiting for Send. Kept for this story. ' +
  'A note from a drafted comment waits for Send, since Claude wrote it from the PR.';
const SEND_TITLE =
  'Hands every draft note to the Claude session as one request: it makes one change for them, commits it ' +
  'as your repo rules say and never pushes. Sent notes are locked until it reports back.';
const TAKE_BACK_TITLE = 'Brings these notes back as drafts, to edit or send again';

/** A note being edited: a textarea that takes focus when it appears and keeps what is typed, and Save and Cancel. */
function NoteEditor(props: {
  note: FixNote;
  off: (control: string) => boolean;
  save(text: string): void;
  cancel(): void;
}) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    area.current?.focus(); // just opened (a redraw keeps the same editor, so it does not take focus again)
  }, []);
  const { note } = props;
  return html`<textarea class="ou-fixedit" rows="3" ref=${area}>${note.body}</textarea><div class="ou-fixeditbtns"><button data-fix-act="save" disabled=${props.off(`save:${note.id}`)} onClick=${() => props.save(area.current ? area.current.value : '')}>Save</button> <button data-fix-act="cancel" onClick=${props.cancel}>Cancel</button></div>`;
}

export function createFixes(context: PanelContext) {
  const { state, opts, shell } = context;
  let view: FixesView | null = null; // the bridge's {notes, auto_send, to, requests}
  let editing: string | null = null; // the id of the note whose text is being edited
  let busy = false;
  let busyKey: string | null = null; // the control a change in flight was started by (it is off meanwhile)
  let pendingAuto = false; // what the Auto-send box was ticked to, until the bridge answers

  const canAdd = () => takesNotes(view);
  const off = (control: string) => busyKey === control;

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

  function placeView(note: FixNote) {
    const line = Number(note.line) > 0 ? note.line : null;
    const where = line ? formatLineRef(note.path, { side: note.side, start: line }) : note.path;
    const props = context.refs.jumpProps(
      note.path,
      line ? { side: toSide(note.side), start: line, end: line } : null,
    );
    return html`<code ...${props}>${where}</code>`;
  }

  /** Where the note has got, under its text. */
  function stateView(note: FixNote) {
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

  function noteView(note: FixNote) {
    const draft = note.state === 'draft' && canAdd();
    const buttons =
      draft &&
      html`<button data-fix-act="edit" onClick=${() => edit(note.id)}>Edit</button><button data-fix-act="remove" disabled=${off(`remove:${note.id}`)} onClick=${() => remove(note.id)}>Remove</button>`;
    const text =
      draft && editing === note.id
        ? html`<${NoteEditor} note=${note} off=${off} save=${(body: string) => save(note.id, body)} cancel=${cancel} />`
        : html`<pre>${note.body}</pre>`;
    const head = html`<div class="ou-where"><span>${placeView(note)}</span><span class="ou-cbtns">${buttons}</span></div>`;
    return html`<div key=${note.id} class=${`ou-comment ou-fixnote ou-fx-${note.state}`} data-note-id=${note.id}>${head}${text}<div class="ou-cstate">${stateView(note)}</div></div>`;
  }

  /** Send, Auto-send, and Take back for each request still with a session. */
  function toolsView(summary: FixSummary) {
    // drawn only with the bridge's view
    const send =
      summary.send &&
      html`<button data-fix-act="send" title=${SEND_TITLE} disabled=${off('send')} onClick=${send_}>${summary.send}</button>`;
    const ticked = off('auto') ? pendingAuto : !!view!.auto_send;
    const auto = html`<label class="ou-fixauto" title=${AUTO_TITLE}><input type="checkbox" data-fix-act="auto" checked=${ticked} disabled=${off('auto')} onClick=${(event: Event) => setAuto((event.currentTarget as HTMLInputElement).checked)} /> Auto-send</label>`;
    const takeBack = view!.requests
      .filter((request) => request.status === 'pending')
      .map((request) => {
        const notes = plural(request.notes.length, 'note');
        const sentTo = request.claimed_by || request.to || 'the next session';
        return html` <${LinkButton} data-fix-act="take_back" data-request=${request.id} title=${TAKE_BACK_TITLE} disabled=${off(`take_back:${request.id}`)} onClick=${() => takeBack_(request.id)}>Take back the ${notes} sent to ${sentTo}</${LinkButton}>`;
      });
    const nobody =
      summary.send &&
      !view!.to &&
      html`<div class="ou-quiet">No Claude session takes fix requests for this story yet: a send waits for the next one.</div>`;
    return html`<div class="ou-fixtools">${send}${auto}${takeBack}</div>${nobody}`;
  }

  /** The box's content: the heading with its counts, the tools, the notes. Nothing before the bridge's view, or with no notes and no Auto-send. */
  function boxView() {
    if (!view || (!view.notes.length && !(view.auto_send && canAdd()))) {
      return null;
    }
    const summary = fixSummary(view);
    const notes = shownNotes();
    const elsewhere = view.notes.length - notes.length;
    const more =
      elsewhere > 0 &&
      html`<div class="ou-quiet">${plural(elsewhere, 'more note')} on other chapters' files (all on the Overview).</div>`;
    const counts = summary.counts && `(${summary.counts})`;
    return html`<h2 class="ou-h">Fix before push (${view.notes.length}) <span class="ou-draftsum">${counts}</span></h2>${canAdd() && toolsView(summary)}${notes.map(noteView)}${more}`;
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
    shell.redraw();
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

  // ---------- what the controls do (each is on its own element)

  function edit(id: string) {
    editing = id;
    shell.redraw();
  }

  function cancel() {
    editing = null;
    shell.redraw();
  }

  function save(id: string, body: string) {
    return guarded(`save:${id}`, async () => {
      const text = body.trim();
      if (text) {
        await opts.fixes!.note(id, { body: text });
      }
      editing = null;
      await refresh();
      shell.redraw();
    });
  }

  function remove(id: string) {
    return guarded(`remove:${id}`, async () => {
      await opts.fixes!.note(id, { delete: true });
      await refresh();
    });
  }

  const send_ = () => guarded('send', send);

  function setAuto(ticked: boolean) {
    pendingAuto = ticked; // the box stays as it was ticked until the bridge answers
    return guarded('auto', async () => {
      take(await opts.fixes!.act({ action: 'auto', on: ticked }));
    });
  }

  function takeBack_(request: string) {
    return guarded(`take_back:${request}`, async () => {
      take(await opts.fixes!.act({ action: 'take_back', request }));
    });
  }

  /** Hands every draft note to a Claude session as one request, and says where it went. */
  async function send() {
    const next = await opts.fixes!.act({ action: 'send' });
    shell.message(
      next.sent && next.sent.to
        ? `Sent to ${next.sent.to}. Its notes are locked until it reports back.`
        : 'Queued: the next Claude session that takes fix requests for this story gets it.',
    );
    take(next);
  }

  /** Runs one change one at a time, with its control (if it has one) off meanwhile, and says why it failed. */
  async function guarded(control: string | null, work: () => Promise<void>) {
    if (busy || !opts.fixes) {
      return;
    }
    busy = true;
    busyKey = control;
    if (control) {
      shell.redraw();
    }
    try {
      await work();
    } catch (err) {
      shell.message(
        `Couldn't save that: ${err && (err as Error).message ? (err as Error).message : err}`,
      );
      await refresh();
    } finally {
      busy = false;
      busyKey = null;
      if (control) {
        shell.redraw();
      }
    }
  }

  /** Send, from outside the panel's own buttons (the local page's top bar): the same request, the same message. */
  const sendNotes = () => guarded(null, send);

  refresh();

  return { view: boxView, refresh, canAdd, sendNotes };
}

export type Fixes = ReturnType<typeof createFixes>;
