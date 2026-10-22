/*
 * The bridge's one HTML page: the local page's shell, which loads local.js
 * with the story id and token.
 */
import { escapeHtml } from '../../shared/util/html.js';

/** The pages' CSP: only the bridge's own scripts, styles and connections. */
export const pageHeaders = () => ({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

export function localPage(id, meta, token) {
  const boot = JSON.stringify({ story: id, token }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title><link rel="stylesheet" href="/assets/local.css">
<script type="application/json" id="ds-boot">${boot}</script>
<script type="module" src="/assets/local.js"></script></head>
<body class="ds-local"><div id="ds-app"><p class="ds-muted ds-loading">Loading the story…</p></div></body></html>`;
}
