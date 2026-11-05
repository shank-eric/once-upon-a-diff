/*
 * The Mark viewed button as a node, drawn in the file list and beside a file's mention in the story's text. Its label follows the file's own
 * Viewed toggle: "Mark viewed" until the toggle is on, then "Viewed ✓" (a click unticks it).
 */
import { html } from '/assets/preact.mjs';
import type { VNode } from '@once-upon-a-diff/ui-kit/parse-markup';

/** The same button as a node: `toggleOn` is whether the file's Viewed toggle is on (null before the tracker has looked). */
export function markViewedNode(
  rel: string,
  short: boolean,
  toggleOn: boolean | null,
  onClick: () => void,
): VNode {
  const viewed = toggleOn === true;
  let label = short ? 'mark viewed' : 'Mark viewed';
  if (viewed) {
    label = short ? 'viewed ✓' : 'Viewed ✓';
  }
  const title = viewed
    ? `Viewed. Click to untick ${rel}'s Viewed checkbox`
    : `Tick ${rel}'s Viewed checkbox`;
  return html`<button type="button" class=${`ou-mark ${viewed ? 'ou-st-viewed' : 'ou-st-mark'}`} data-mark-for=${rel} data-mark-short=${short ? '1' : undefined} aria-pressed=${toggleOn === null ? undefined : String(viewed)} title=${title} onClick=${onClick}>${label}</button>`;
}
