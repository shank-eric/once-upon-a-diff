/*
 * The Mark viewed button, drawn in the file list and beside a file's mention in the story's text. The tracker
 * (reading/viewed.ts) keeps its label in step with the file's own Viewed toggle.
 */
import { html } from '@once-upon-a-diff/protocol/domain/html';

/** The Mark viewed button for a file this chapter finishes. The tracker keeps its label in step with the file's Viewed toggle. */
export function markViewedButton(rel: string, short?: boolean) {
  const label = short ? 'mark viewed' : 'Mark viewed';
  return html`<button type="button" class="ou-mark ou-st-mark" data-mark-for="${rel}"${short && html` data-mark-short="1"`} title="Tick ${rel}'s Viewed checkbox">${label}</button>`;
}
