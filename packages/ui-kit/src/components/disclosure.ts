/*
 * Disclosure: a button that opens and closes something, with ▸ (closed) or ▾ (open) in front and `aria-expanded` saying which.
 * The look is the host's, by `class` (and `arrowClass` on the glyph's own span); there is no ui.css rule. `bare` puts the glyph
 * in as the button's whole text, with no span of its own, for a toggle that is only an arrow. `attrs` carries data-* attributes.
 */
import { html } from '/assets/preact.mjs';

export function Disclosure(props: {
  open: boolean;
  onToggle: () => void;
  class?: string;
  title?: string;
  /** The button's accessible name, when its text is not enough. */
  label?: string;
  arrowClass?: string;
  bare?: boolean;
  attrs?: Record<string, unknown>;
  children?: unknown;
}) {
  const {
    open,
    onToggle,
    class: className,
    title,
    label,
    arrowClass,
    bare,
    attrs,
    children,
  } = props;
  const glyph = open ? '▾' : '▸';
  const arrow = bare ? glyph : html`<span class=${arrowClass} aria-hidden="true">${glyph}</span>`;
  return html`<button type="button" class=${className} ...${attrs} aria-expanded=${String(open)} aria-label=${label} title=${title} onClick=${onToggle}>${arrow}${children}</button>`;
}
