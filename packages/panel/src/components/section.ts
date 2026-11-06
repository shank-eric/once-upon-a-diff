/*
 * Section: the panel's folded box, a <details> with its heading in the <summary> and the ▸ (closed) or ▾ (open) the stylesheet draws
 * in front of it (css/panel.css, "details:is(.ou-filesbox, .ou-allc)"). The file list's "Files in this chapter" and the Overview's
 * "all chapters" comments are two of them. The caller says which box it is by `class` (the look beyond the fold is its own), whether
 * it is `open`, and what `onToggle` does with the browser's open and close; the browser keeps the keyboard behavior.
 */
import { html } from '/assets/preact.mjs';

export function Section(props: {
  class: string;
  open: boolean;
  onToggle: (event: Event) => void;
  /** What goes in the <summary>: the heading, and what sits beside it. */
  summary: unknown;
  children?: unknown;
}) {
  const { class: className, open, onToggle, summary, children } = props;
  return html`<details class=${className} open=${open} onToggle=${onToggle}><summary>${summary}</summary>${children}</details>`;
}
