/*
 * Where a fix-before-push note has got. The bridge, the local page and the panel each read it off the same fields.
 */

/** The fields of a note (a LocalNote fits) that say where it has got. */
export interface NoteProgress {
  sent?: { to?: string | null } | null;
  fixed?: unknown;
}

/** Where a note has got: queued is sent with no session taking it yet, so the next one that listens gets it. */
export type FixStage = 'draft' | 'queued' | 'sent' | 'fixed';

/** 'fixed' when it has `fixed`, else 'queued' or 'sent' when it has `sent` (by whether a session took it), else 'draft'. */
export function fixStage(note: NoteProgress): FixStage {
  if (note.fixed) {
    return 'fixed';
  }
  if (note.sent) {
    return note.sent.to ? 'sent' : 'queued';
  }
  return 'draft';
}

/** The three states the bridge's view of a note carries: a queued note counts as sent. */
export function fixState(note: NoteProgress): 'draft' | 'sent' | 'fixed' {
  const stage = fixStage(note);
  return stage === 'queued' ? 'sent' : stage;
}
