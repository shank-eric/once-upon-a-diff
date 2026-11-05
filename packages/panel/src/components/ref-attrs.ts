/*
 * The attributes that make a mention of a file (or of lines in it) a jump link, as html (refAttrs) or as props for a
 * node (refNode). No panel context, so the story's body and its markdown can use them without pulling in file-refs.ts.
 */
import { html } from '@once-upon-a-diff/domain/html';
import type { LineRef } from '@once-upon-a-diff/domain/line-refs';
import type { Html } from '@once-upon-a-diff/domain/html';

/**
 * The data-rel attributes (and data-side/start/end for a line) that make a mention a jump link. role and tabindex
 * put it in the tab order, and the shell turns Enter or Space on it into a click.
 */
export function refAttrs(rel: string, line: LineRef | null | undefined): Html {
  const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
  const attrs = html`data-rel="${rel}" role="link" tabindex="0" title="Scroll to ${rel}${where}"`;
  return line
    ? html`${attrs} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"`
    : attrs;
}

/** The same attributes as props for a node (html`<code ...${refNode(rel, line)}>`). */
export function refNode(rel: string, line: LineRef | null | undefined): Record<string, string> {
  const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
  const props: Record<string, string> = {
    'data-rel': rel,
    role: 'link',
    tabindex: '0',
    title: `Scroll to ${rel}${where}`,
  };
  if (line) {
    props['data-side'] = line.side;
    props['data-start'] = String(line.start);
    props['data-end'] = String(line.end);
  }
  return props;
}
