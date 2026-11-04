/*
 * The Mark viewed button as markup, for the story's text: markdown.ts builds strings, and body.ts turns this one into the node in
 * mark-viewed-node.ts. No Preact here, so the pure helpers that name it stay loadable in Node.
 */
import { html as markup } from '@once-upon-a-diff/protocol/domain/html';

/**
 * The Mark viewed button for a file this chapter finishes, as the markup the story's text carries (markdown.ts builds strings:
 * body.ts turns it into mark-viewed-node.ts's node). `short` is the lower-case one beside a mention.
 */
export function markViewedButton(rel: string, short?: boolean) {
  const label = short ? 'mark viewed' : 'Mark viewed';
  return markup`<button type="button" class="ou-mark ou-st-mark" data-mark-for="${rel}"${short && markup` data-mark-short="1"`} title="Tick ${rel}'s Viewed checkbox">${label}</button>`;
}
