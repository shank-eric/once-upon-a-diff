/*
 * HTML escaping for markup built as strings. Used by the panel, the content
 * scripts, the local page and the bridge's server, so it has no DOM or Node
 * dependencies.
 */

/** Escapes &, <, > and " so the text is safe in element content and in a double-quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The reverse of escapeHtml, for text that was escaped before a pass that needs the raw characters. */
export function unescapeHtml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
