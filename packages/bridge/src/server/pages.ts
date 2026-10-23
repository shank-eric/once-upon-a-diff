/*
 * The bridge's one HTML page: the local page's shell, which loads local.js
 * with the story id and token.
 */
import { html, raw } from '@once-upon-a-diff/shared/util/html';

/** The pages' CSP: only the bridge's own scripts, styles and connections. */
export const pageHeaders = () => ({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

export function localPage(id: string, meta: { title: string }, token: string): string {
  // the boot JSON goes in as is: with every < written <, it can't end its script element
  const boot = raw(JSON.stringify({ story: id, token }).replace(/</g, '\\u003c'));
  return String(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title}</title><link rel="stylesheet" href="/assets/local.css">
<script type="application/json" id="ou-local-boot">${boot}</script>
<script type="module" src="/assets/local.ts"></script></head>
<body class="ou-local"><div id="ou-local-app"><p class="ou-local-muted ou-local-loading">Loading the story…</p></div></body></html>`);
}
