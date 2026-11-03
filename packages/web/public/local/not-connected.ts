/*
 * What the board page says when the bridge refuses it for lack of a key: no cookie from an earlier visit and
 * no #key= in the link. It says how to connect and links to the README. The page keeps polling, so once the cookie is
 * there (the extension's button or `once-upon board` in another tab) it fills in by itself.
 */
import { html } from '/assets/protocol/domain/html.ts';

const README = 'https://github.com/shank-eric/once-upon-a-diff#first-run-the-board';

/** The "Not connected yet" panel for the `board` page. */
export function notConnectedHtml() {
  const button = 'Open board';
  const command = 'once-upon board';
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
