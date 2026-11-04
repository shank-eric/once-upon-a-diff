/*
 * LinkButton: a button that reads as a small dotted link, for an action beside text (Dismiss, Undo, Jump to line). Styled by
 * ui.css (`ou-ui-linkish`). Every other prop (`type`, `data-*`, `title`, `disabled`, `onClick`) goes to the button as given.
 */
import { html } from '/assets/preact.mjs';

export function LinkButton({ children, ...rest }: { children?: unknown; [prop: string]: unknown }) {
  return html`<button class="ou-ui-linkish" ...${rest}>${children}</button>`;
}
