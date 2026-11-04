/*
 * What the "no string DOM" pins of the panel and of ui share: the pattern for every way code can write into a node by hand, a
 * count of those writes in a source, and the list of a folder's .ts files. A pin is a table of file: count in the test of the
 * package it guards, and a count can only fall.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Every way the panel could write into a node by hand, as a source pattern. */
export const WRITES = new RegExp(
  [
    String.raw`\bsetHtml\(`,
    String.raw`\binsertHtml\(`,
    String.raw`\.(innerHTML|outerHTML|innerText)\b`,
    String.raw`\.insertAdjacent(HTML|Element|Text)\(`,
    String.raw`\.(textContent|title|value|checked|open|hidden|disabled|className|id|href|src)\s*=(?!=)`,
    String.raw`\.style\b`,
    String.raw`\.dataset\b[^=\n]*=(?!=)`,
    String.raw`\.on[a-z]+\s*=(?!=)`,
    String.raw`\.(setAttribute|removeAttribute|toggleAttribute)\(`,
    String.raw`\.classList\.(add|remove|toggle|replace)\(`,
    String.raw`\baddEventListener\(`,
    String.raw`\.(replaceChildren|append|prepend|before|after|appendChild|insertBefore|removeChild|replaceWith|remove)\(`,
    String.raw`\bdocument\.(createElement|createTextNode)\(`,
  ].join('|'),
  'g',
);

/** Source with its comments taken out (a `//` after a space or at a line's start, and block comments). */
export const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
export const writesIn = (source: string) => [...code(source).matchAll(WRITES)].length;

export function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return files(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
