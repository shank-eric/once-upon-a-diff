/*
 * The attributes that make a mention of a file (or of lines in it) a jump link, as html (refAttrs) or as props for a
 * node (refNode). No panel context, so the story's body and its markdown can use them without pulling in file-refs.ts.
 */
import { html } from '@once-upon-a-diff/terms/html';
import type { LineRef } from '@once-upon-a-diff/terms/line-refs';
import type { Html } from '@once-upon-a-diff/terms/html';

/** The title of a jump link: where it goes, and when the code there has changed since the story was told, that it may have moved. */
function titleOf(
  rel: string,
  line: LineRef | null | undefined,
  moved: boolean | undefined,
): string {
  const where = line ? ` line ${line.start}${line.end === line.start ? '' : `–${line.end}`}` : '';
  return `Scroll to ${rel}${where}${moved ? ' (may have moved: the code there changed since this story was told)' : ''}`;
}

/**
 * The data-rel attributes (and data-side/start/end for a line) that make a mention a jump link. role and tabindex
 * put it in the tab order, and the shell turns Enter or Space on it into a click. `moved` (ChapterRef.moved) marks it
 * "may have moved".
 */
export function refAttrs(rel: string, line: LineRef | null | undefined, moved?: boolean): Html {
  const attrs = html`data-rel="${rel}" role="link" tabindex="0" title="${titleOf(rel, line, moved)}"`;
  const placed = line
    ? html`${attrs} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"`
    : attrs;
  return moved ? html`${placed} class="ou-moved"` : placed;
}

/** The same attributes as props for a node (html`<code ...${refNode(rel, line)}>`). */
export function refNode(
  rel: string,
  line: LineRef | null | undefined,
  moved?: boolean,
): Record<string, string> {
  const props: Record<string, string> = {
    'data-rel': rel,
    role: 'link',
    tabindex: '0',
    title: titleOf(rel, line, moved),
  };
  if (line) {
    props['data-side'] = line.side;
    props['data-start'] = String(line.start);
    props['data-end'] = String(line.end);
  }
  if (moved) {
    props.class = 'ou-moved';
  }
  return props;
}
