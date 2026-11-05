/*
 * ResizeGrip: the thin handle that resizes a panel, as a keyboard-reachable separator. `drag` is a createDrag's (its handlers go on
 * the handle); `onKeyDown` is the caller's own keys (which arrows widen and by how much differs by panel). The handle's look and
 * place (its edge, its cursor) are the host's, by `class`; `gripRef` is the element, for the caller to keep `aria-valuenow` current.
 */
import { html } from '/assets/preact.mjs';
import type { createDrag } from '../drag.ts';

export function ResizeGrip(props: {
  drag: ReturnType<typeof createDrag>;
  class: string;
  label: string;
  orientation: 'vertical' | 'horizontal';
  /** The least the panel can be: the separator's aria-valuemin. */
  min: number;
  title: string;
  onKeyDown?: (event: KeyboardEvent) => void;
  gripRef?: { current: HTMLElement | null };
}) {
  const { drag, class: className, label, orientation, min, title, onKeyDown, gripRef } = props;
  return html`<div class=${className} ref=${gripRef} role="separator" aria-orientation=${orientation} aria-label=${label} aria-valuemin=${min} tabindex="0"
    title=${title} ...${drag.handlers} onKeyDown=${onKeyDown}></div>`;
}
