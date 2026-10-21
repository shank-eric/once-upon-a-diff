/*
 * The bridge's two HTML pages: the index of stories it can serve, and the
 * local page's shell, which loads local.js with the story id and token.
 */
import { escapeHtml } from '../../src/js/shared/util/html.js';

/** The pages' CSP: only the bridge's own scripts, styles and connections. */
export const pageHeaders = () => ({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

function storyLink(story) {
  if (story.kind === 'local') {
    return `/local/${encodeURIComponent(story.id)}/`;
  }
  return story.url ? `${story.url}/changes` : null;
}

function storyWhere(story) {
  if (story.kind === 'local') {
    return 'local commits';
  }
  return story.repo ? `${story.repo}#${story.number}` : '';
}

export function indexPage(list) {
  const rows = list
    .map((story) => {
      const href = storyLink(story);
      const target = story.kind === 'local' ? '' : ' target="_blank" rel="noopener noreferrer"';
      const title = href
        ? `<a href="${escapeHtml(href)}"${target}>${escapeHtml(story.title)}</a>`
        : escapeHtml(story.title);
      return `<li>${title} <span class="ds-muted">${escapeHtml(storyWhere(story))} · ${escapeHtml(story.id)}</span></li>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diff Story Mode</title><link rel="stylesheet" href="/assets/local.css"></head>
<body class="ds-index"><main><h1>Diff Story Mode</h1><p class="ds-muted">Stories the bridge can serve. PR stories open on GitHub, where the extension shows the panel. Local stories open here.</p>
<ul class="ds-stories">${rows || '<li class="ds-muted">No stories yet.</li>'}</ul></main></body></html>`;
}

export function localPage(id, meta, token) {
  const boot = JSON.stringify({ story: id, token }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title><link rel="stylesheet" href="/assets/local.css">
<script type="application/json" id="ds-boot">${boot}</script>
<script type="module" src="/assets/local.js"></script></head>
<body class="ds-local"><div id="ds-app"><p class="ds-muted ds-loading">Loading the story…</p></div></body></html>`;
}
