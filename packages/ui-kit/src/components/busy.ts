/*
 * Busy: a line of text with a spinner in front, for something in progress. Styled by ui.css (`ou-ui-busy`, `ou-ui-spin`); a
 * host places it (a margin, a flex slot) with its own rule.
 */
import { html } from '/assets/preact.mjs';

export function Busy(props: { children?: unknown }) {
  return html`<span class="ou-ui-busy" role="status"><span class="ou-ui-spin" aria-hidden="true"></span>${props.children}</span>`;
}
