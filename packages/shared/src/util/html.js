/*
 * Markup built as strings: escaping, and the html`` tag that escapes every
 * value it's given unless it's markup already. Used by the panel, the content
 * scripts, the local page and the bridge's server, so it has no DOM or Node
 * dependencies.
 */

/** Escapes &, <, >, " and ' so the text is safe in element content and in a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The reverse of escapeHtml, for text that was escaped before a pass that needs the raw characters. */
export function unescapeHtml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Markup that html`` puts in as is: what html`` returns, and what raw() marks. It turns into its markup wherever a
 * string is wanted (String(), a plain template literal, +), so string-built markup can take it too.
 */
export class Html {
  constructor(markup) {
    this.markup = markup;
  }
  toString() {
    return this.markup;
  }
}

/** Marks markup our own code built as a string (the markdown renderer's, a regex pass's) as safe to put in as is. */
export function raw(markup) {
  return markup instanceof Html ? markup : new Html(String(markup ?? ''));
}

/** One ${value}: markup as is, an array's items one after another, nothing for null, undefined or false, else escaped text. */
function interpolate(value) {
  if (value instanceof Html) {
    return value.markup;
  }
  if (Array.isArray(value)) {
    return value.map(interpolate).join('');
  }
  if (value === null || value === undefined || value === false) {
    return '';
  }
  return escapeHtml(value);
}

/**
 * A tagged template for markup: every ${value} is escaped, so text from a story, a PR or a person can't add
 * elements or attributes. html`` results and raw() go in as is, arrays are joined, and null, undefined and false
 * give nothing (so ${cond && html`...`} works). Attribute values go in quotes.
 * @returns {Html}
 */
export function html(strings, ...values) {
  let markup = strings[0];
  for (let i = 0; i < values.length; i++) {
    markup += interpolate(values[i]) + strings[i + 1];
  }
  return new Html(markup);
}
