// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * How a story's text points at lines, read the same way by the panel
 * (file-refs.js, markdown.js) and the bridge (stories/text-refs.mjs): a
 * backticked `path:45`, `path:40-58`, `path:L12` or bare `:45`, and a link to
 * a file's diff with a line anchor (#diff-<sha256>R45). Only the syntax lives
 * here. Each side resolves the names to files by its own rules.
 */

const LINE_SUFFIX = /^(.*?):([LR])?(\d+)(?:-[LR]?(\d+))?$/;
const DIFF_LINK = /#diff-([0-9a-f]{64})(?:([LR])(\d+)(?:-[LR]?(\d+))?)?$/;

function lineOf(side, first, last) {
  const start = +first;
  const end = +(last || first);
  return { side: side || 'R', start: Math.min(start, end), end: Math.max(start, end) };
}

/** A backticked name and its line suffix: {name, line}, line null when there's none and name '' for a bare `:45`. */
export function parseLineRef(code) {
  const name = String(code).trim().replace(/^\.\//, '');
  const match = LINE_SUFFIX.exec(name);
  return match
    ? { name: match[1], line: lineOf(match[2], match[3], match[4]) }
    : { name, line: null };
}

/** A link to a file's diff on GitHub: {sha, line} (line null without an anchor), or null when it isn't one. */
export function parseDiffLink(url) {
  const match = DIFF_LINK.exec(String(url));
  if (!match) {
    return null;
  }
  return { sha: match[1], line: match[3] ? lineOf(match[2], match[3], match[4]) : null };
}
