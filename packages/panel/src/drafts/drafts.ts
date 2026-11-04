/*
 * How a drafted comment shows (drafts-part.ts draws the comments): draftView says what a draft row from the bridge
 * means for the panel, and shownIn whether a comment's text is on the page already.
 *
 * No DOM and no Preact here, so node tests can use them.
 */
import type { DraftRow } from '@once-upon-a-diff/protocol/types';

/** How a draft shows: see draftView. */
export type DraftShow = 'dismissed' | 'fix' | 'posted' | 'pending' | 'added' | 'draft';

/**
 * How the panel shows one draft row from the bridge: 'dismissed', 'fix', 'posted', 'pending', 'added' or 'draft'.
 * 'added' is Add to my review's own state: it's in their pending review, but GitHub doesn't redraw an open
 * Files changed page for that, so this page doesn't show it yet. It turns into the usual posted or pending
 * display once gh matches it on a page loaded after the add, or the comment turns up on the page (onPage).
 * settle: the add is confirmed, so the bridge can drop its `added` mark.
 */
export function draftView(
  row: Partial<DraftRow> | null | undefined,
  { pageAt = 0, onPage = false } = {},
): { show: DraftShow; settle: boolean } {
  const draft = row || { status: 'draft', dismissed: false };
  if (draft.dismissed) {
    return { show: 'dismissed', settle: false };
  }
  if (draft.fix) {
    return { show: 'fix', settle: false }; // a draft that's now a fix-before-push note
  }
  const known = draft.status === 'posted' || draft.status === 'pending' ? draft.status : 'draft';
  if (!draft.added) {
    return { show: known, settle: false };
  }
  const fromGithub = draft.source === 'github';
  if (draft.status === 'posted') {
    return { show: 'posted', settle: fromGithub };
  }
  if (fromGithub && draft.status === 'pending' && pageAt > (Date.parse(draft.added.at) || 0)) {
    return { show: 'pending', settle: true };
  }
  if (onPage) {
    return { show: 'pending', settle: false };
  }
  return { show: 'added', settle: false };
}

const plainText = (text: string | null | undefined) =>
  String(text || '')
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Does one of these comment texts on the page (rendered markdown) show this draft's body? */
export function shownIn(texts: (string | null)[], body: string): boolean {
  const want = plainText(body).slice(0, 160);
  if (want.length < 8) {
    return false;
  }
  return texts.some((text) => plainText(text).includes(want));
}
