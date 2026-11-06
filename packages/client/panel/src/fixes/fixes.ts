/*
 * Fix before push: the story's notes, which collect as drafts (Add to fix before push on a drafted comment, or a
 * line note on the local page) until Send N notes to <session> hands them to a Claude session as one fix request.
 * A draft note can be edited or removed. A sent one shows "Sent to <session>", then "Fixed in <sha>" when the
 * session reports back, or comes back as a draft with why. Auto-send (per story, off by default) sends each note as
 * it's added, and a request nobody has reported on can be taken back. opts.fixes talks to the bridge:
 * {load(), act(body), note(id, changes), onChange(view)}.
 *
 * Fix before push is for the viewer's own work: when the bridge says the story can't take new notes (`can_add` false,
 * a PR that isn't the viewer's), the tools and the draft's Add to fix before push are hidden, and notes already there
 * are listed as read-only text.
 *
 * The Overview lists every note; a chapter lists the notes on its files, with the same Send for the whole batch.
 *
 * This file has no DOM and no Preact (fixes-part.ts draws the box), so node tests can use fixSummary and takesNotes.
 */
import { plural } from '@once-upon-a-diff/terms/text';
import type { FixNote, FixesView } from '@once-upon-a-diff/contracts/types';

export type FixSummary = { drafts: number; send: string | null; counts: string };

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

/** New notes can be added: not before the bridge's view is in, and not on a PR that isn't the viewer's own. */
export const takesNotes = (view: Pick<FixesView, 'can_add'> | null): boolean =>
  !!view && view.can_add !== false;
