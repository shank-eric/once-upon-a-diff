/*
 * What a host page's diff gives the panel to work with, with no DOM calls: the file blocks and tree rows it finds, and the
 * rows of a file's table as expandStep reads them. The host adapter (shared/src/host/diff-dom.ts) makes them, the panel's
 * expand and viewed parts read them.
 */

/** A file's block on the page: el is what the filter hides. */
export interface FileBlock {
  rel: string;
  el: Element;
}

/** A file-tree row: a file's (rel) or a folder's (dir, null when the page doesn't say which). */
export interface TreeRow {
  rel?: string;
  dir?: string | null;
  el: Element;
}

/** Which way an expand control opens. */
export type ExpandDir = 'up' | 'down' | 'all';

/** A row of a file's table as expandStep reads it: a hunk row with its controls, or a drawn row and its line. */
export type ExpandRow =
  | { gap: ExpandDir[]; controls: Partial<Record<ExpandDir, HTMLElement>>; n?: undefined }
  | { n: number | null; gap?: undefined };

/** Which way an expand control opens: 'up', 'down' or 'all', from data-direction or its label ("Expand Up", "Expand file down from line 82"). */
export function expandDirOf(direction: string | null | undefined, label: string): ExpandDir | null {
  const dataDirection = String(direction || '').toLowerCase();
  if (dataDirection === 'up' || dataDirection === 'down' || dataDirection === 'all') {
    return dataDirection;
  }
  const text = String(label || '').toLowerCase();
  if (/\bup\b/.test(text)) {
    return 'up';
  }
  if (/\bdown\b/.test(text)) {
    return 'down';
  }
  if (/\ball\b|\bfrom line \d+ to line\b/.test(text)) {
    return 'all';
  }
  return null;
}
