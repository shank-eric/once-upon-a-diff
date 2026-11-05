/*
 * Chips: small neutral labels. What one means is said by a mark in front (✓ or !), not by its colour. Styled by ui.css
 * (`ou-ui-chip`, and `ou-ui-chips` for a wrapping row of them); a host adds its own class for its own placement.
 */
import { html } from '/assets/preact.mjs';

export type ChipTone = 'ok' | 'plain' | 'warn' | 'bad';

const MARK: Record<ChipTone, string> = { ok: '✓ ', plain: '', warn: '! ', bad: '! ' };

/** One chip. With a `tone` its mark goes in front of the text. */
export function Chip(props: { tone?: ChipTone; children?: unknown }) {
  const { tone, children } = props;
  return tone === undefined
    ? html`<span class="ou-ui-chip">${children}</span>`
    : html`<span class="ou-ui-chip">${MARK[tone]}${children}</span>`;
}

/** A wrapping row of chips: a plain text, or a text with its tone. `class` is added to the row's own. */
export function Chips(props: {
  items: readonly (string | { text: string; tone: ChipTone })[];
  class?: string;
}) {
  const { items, class: extra } = props;
  return html`<div class=${extra ? `ou-ui-chips ${extra}` : 'ou-ui-chips'}>${items.map((item) =>
    typeof item === 'string'
      ? html`<${Chip}>${item}</${Chip}>`
      : html`<${Chip} tone=${item.tone}>${item.text}</${Chip}>`,
  )}</div>`;
}
