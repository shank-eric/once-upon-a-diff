/*
 * Chips: small labels. The plain one is neutral, and what it means is said by a mark in front (✓ or !), not by its colour. A `tone` draws
 * the text and the border in a colour (a status pill, a stage), `tint` and `strong` and `size` set the rest of the look
 * (chip-class.ts). Styled by ui.css (`ou-ui-chip`, and `ou-ui-chips` for a wrapping row of them); a host adds its own class for its own
 * placement.
 */
import { html } from '/assets/preact.mjs';
import { chipClass, type ChipLook } from './chip-class.ts';

export type { ChipTone, ChipSize } from './chip-class.ts';
export type ChipMark = 'ok' | 'plain' | 'warn' | 'bad';

const MARK: Record<ChipMark, string> = { ok: '✓ ', plain: '', warn: '! ', bad: '! ' };

/**
 * One chip: a span, or a button with `as` (no link: nothing draws one, and a link would need its own underline and colour rules).
 * With a `mark` it goes in front of the text. `class` is the host's own; every other prop (`title`, `data-*`, `onClick`)
 * goes to the element as given. A button is a `type="button"` unless it says otherwise.
 */
export function Chip(
  props: ChipLook & { as?: 'span' | 'button'; mark?: ChipMark; children?: unknown } & Record<
      string,
      unknown
    >,
) {
  const {
    as: element = 'span',
    mark,
    children,
    tone,
    tint,
    strong,
    size,
    class: extra,
    ...rest
  } = props;
  const className = chipClass({ tone, tint, strong, size, class: extra });
  const body = mark === undefined ? children : html`${MARK[mark]}${children}`;
  if (element === 'button') {
    return html`<button type="button" ...${rest} class=${className}>${body}</button>`;
  }
  return html`<span ...${rest} class=${className}>${body}</span>`;
}

/** A wrapping row of chips: a plain text, or a text with its mark. `class` is added to the row's own. */
export function Chips(props: {
  items: readonly (string | { text: string; mark: ChipMark })[];
  class?: string;
}) {
  const { items, class: extra } = props;
  return html`<div class=${extra ? `ou-ui-chips ${extra}` : 'ou-ui-chips'}>${items.map((item) =>
    typeof item === 'string'
      ? html`<${Chip}>${item}</${Chip}>`
      : html`<${Chip} mark=${item.mark}>${item.text}</${Chip}>`,
  )}</div>`;
}
