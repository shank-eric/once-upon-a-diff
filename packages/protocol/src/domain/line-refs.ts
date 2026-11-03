/*
 * How a story's text points at lines. A story links by data: a chapter's `refs` entry has an id, and the text links to
 * it as `[text](ref:<id>)` (refLinkId, refIdsIn). A link to a file's diff with a line anchor (#diff-<sha256>R45) names
 * its file by an exact id, so it jumps too (parseDiffLink). The backticked `path:45`, `path:40-58`, `path:L12` and bare
 * `:45` forms (parseLineRef) link nothing: only the bridge reads them, to upgrade an older story and to lint a new one.
 */

/** A side of a file's diff: 'L' the old lines, 'R' the new. */
export type Side = 'L' | 'R';

const LINE_SUFFIX = /^(.*?):([LR])?(\d+)(?:-[LR]?(\d+))?$/;
const DIFF_LINK = /#diff-([0-9a-f]{64})(?:([LR])(\d+)(?:-[LR]?(\d+))?)?$/;

/** A backticked name's line suffix, or a diff link's anchor, as lines on one side. */
export interface LineRef {
  side: Side;
  start: number;
  end: number;
}

function lineOf(side: string | undefined, first: string, last: string | undefined): LineRef {
  const start = +first;
  const end = +(last || first);
  // the patterns only match L or R
  return { side: (side || 'R') as Side, start: Math.min(start, end), end: Math.max(start, end) };
}

/** A backticked name and its line suffix: {name, line}, line null when there's none and name '' for a bare `:45`. */
export function parseLineRef(code: string): { name: string; line: LineRef | null } {
  const name = String(code).trim().replace(/^\.\//, '');
  const match = LINE_SUFFIX.exec(name);
  return match
    ? { name: match[1], line: lineOf(match[2], match[3], match[4]) }
    : { name, line: null };
}

/** A link to a file's diff on GitHub: {sha, line} (line null without an anchor), or null when it isn't one. */
export function parseDiffLink(url: string): { sha: string; line: LineRef | null } | null {
  const match = DIFF_LINK.exec(String(url));
  if (!match) {
    return null;
  }
  return { sha: match[1], line: match[3] ? lineOf(match[2], match[3], match[4]) : null };
}

/** What a ref's id may be: the author's short slug, unique in its chapter. */
export const REF_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The id a link's target names (`ref:load`), or null when it is not a ref link. */
export function refLinkId(url: string): string | null {
  const match = /^ref:([a-z0-9][a-z0-9-]*)$/.exec(String(url));
  return match ? match[1] : null;
}

/** The ids of the ref links in a markdown text, in order, code blocks left out. */
export function refIdsIn(text: string): string[] {
  const src = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  return [...src.matchAll(/\[[^\]]*\]\((ref:[^)\s]*)\)/g)].map(
    (match) => refLinkId(match[1]) ?? match[1].slice(4),
  );
}
