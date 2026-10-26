/*
 * What the board and inbox pages say when the bridge refuses them for lack of a key: no cookie from an earlier visit and
 * no #key= in the link. It says how to connect and links to the README. The pages keep polling, so once the cookie is
 * there (the extension's button or `once-upon board` in another tab) the page fills in by itself.
 */
import { html } from '/assets/util/html.ts';

const README = 'https://github.com/shank-eric/once-upon-a-diff#first-run-the-board-and-the-inbox';

/** The "Not connected yet" panel for the `board` or the `inbox` page. */
export function notConnectedHtml(page: 'board' | 'inbox') {
  const button = page === 'board' ? 'Open board' : 'Open inbox';
  const command = page === 'board' ? 'once-upon board' : 'once-upon review';
  return html`<main class="ou-not-connected">
    <h1>Not connected yet</h1>
    <p>This page needs a key from the bridge, and this browser doesn't have one yet. Either:</p>
    <ul>
      <li>click <b>${button}</b> in the Once Upon a Diff extension (open its options page, or the extension's Options), or</li>
      <li>run <code>${command}</code> in a terminal.</li>
    </ul>
    <p class="ou-local-muted">Both open this page with a link that connects it. <a href="${README}" target="_blank" rel="noopener">First-run steps in the README</a></p>
  </main>`;
}
