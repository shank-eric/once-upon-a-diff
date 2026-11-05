/*
 * Syntax highlighting for the page's files (highlight.js, vendored and served by the bridge; the page works without it). A file's
 * lines are highlighted once and kept (rel|hash|whitespace), and the page has a budget of lines to highlight in one draw, spent
 * in file order: past it a file is drawn plain, and not kept, so a smaller diff gets it. The HTML here is highlight.js's own
 * output, which escapes the text: table.ts's Code is the only place that puts it on the page.
 */
import { highlightFile, LIMITS, type Highlighter } from './syntax.ts';
import type { LocalFile } from '/assets/types.ts';

/** A file's highlighted lines: per hunk, per line HTML (null for a line drawn plain), or null for a plain file. */
export type Highlights = (string | null)[][] | null;

const cache = new Map<string, Highlights>();

/** Each file's highlights (by rel), with a new budget: what the old page did on each draw of the whole page. */
export function highlightsFor(
  files: readonly LocalFile[],
  hideWhitespace: boolean,
  hljs: Highlighter | null,
): Map<string, Highlights> {
  const out = new Map<string, Highlights>();
  let budget = 0;
  for (const file of files) {
    // a file with no lines to draw (binary, whitespace only, no hunks) takes nothing
    if (file.binary || file.whitespace_only || !file.hunks.length) {
      continue;
    }
    const key = `${file.rel}|${file.hash}|${hideWhitespace}`;
    if (cache.has(key)) {
      out.set(file.rel, cache.get(key) as Highlights);
      continue;
    }
    const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    if (budget + lines > LIMITS.pageLines) {
      out.set(file.rel, null);
      continue;
    }
    budget += lines;
    const lineHtml = highlightFile(file, hljs);
    cache.set(key, lineHtml);
    out.set(file.rel, lineHtml);
  }
  return out;
}
