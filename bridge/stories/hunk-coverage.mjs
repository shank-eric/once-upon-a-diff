/*
 * Every hunk of the diff should be told by some chapter, not only every file.
 *
 * A chapter covers a hunk when something in it points at a line inside that
 * hunk (its context lines count): a `lines` range on one of its file entries,
 * a line reference in its text (text-refs.mjs: `path:40-58`, `path:L12`, a
 * bare `:45`, a diff link with a line), or a drafted comment on that line.
 * `L` ranges and comments are checked against the hunk's old side, the rest
 * against its new side.
 *
 * Listing a file with no line refs covers all its hunks when:
 *   - the file is small (at most SMALL_FILE_LINES changed lines, about a screen)
 *   - the entry says `"whole": true`, the author's call that one chapter tells all of it
 *   - the file is deleted, or a lockfile, where pointing at lines says nothing
 *   - the chapter is a "Since you read it" one, which tells every file its commits touched
 * A file no chapter lists isn't reported here: file placement already says so.
 *
 * The pr-story skill's `build` refuses to publish with uncovered hunks, and
 * file-map.json carries any it was told to allow, for the panel's Overview.
 */
import { lineRefsOf, textOf } from './text-refs.mjs';

export const SMALL_FILE_LINES = 40;
const LOCKFILES =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|Gemfile\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|bun\.lockb?)$/;

/** A hunk's lines on each side, context included: {L: {start, end}, R: {start, end}}. An empty side is its one anchor line. */
function sidesOf(hunk) {
  const span = (start, count) => ({ start, end: start + Math.max(count, 1) - 1 });
  return { L: span(hunk.oldStart, hunk.oldLines), R: span(hunk.newStart, hunk.newLines) };
}

const overlaps = (range, side) => range.start <= side.end && range.end >= side.start;

/** A hunk as a line reference the narrative could use: `path:40-58`, or `path:L12-20` for one that only removes lines. */
export function hunkRef(rel, hunk) {
  const removesOnly = hunk.lines.every((line) => !line.startsWith('+'));
  const side = removesOnly ? 'L' : 'R';
  const { start, end } = sidesOf(hunk)[side];
  return `${rel}:${side === 'L' ? 'L' : ''}${start}${end > start ? `-${end}` : ''}`;
}

/** Does listing this file, with no line refs, cover all of it? */
function coveredByListing(file, entry, chapter) {
  return (
    !!chapter.since ||
    !!entry.whole ||
    file.kind === 'deleted' ||
    LOCKFILES.test(file.rel) ||
    file.stats.added + file.stats.removed <= SMALL_FILE_LINES
  );
}

/** The path a drafted comment names, resolved like a text reference (exact, then a unique suffix), or null. */
function commentRel(comment, rels) {
  const name = String(comment.path || '').replace(/^\.\//, '');
  if (!name || !(Number(comment.line) > 0)) {
    return null;
  }
  if (rels.includes(name)) {
    return name;
  }
  const matches = rels.filter((rel) => rel.endsWith('/' + name));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The hunks no chapter covers: [{rel, hunks: [{side, start, end, ref}]}] in diff order.
 * @param {object[]} chapters chapters.json's chapters, normalized (chaptersOf), with or without addTextRefs
 * @param {Map<string, import('../util/diff.mjs').DiffFile>} diff
 */
export function uncoveredHunks(chapters, diff) {
  const rels = [...diff.keys()];
  const listed = new Set();
  const whole = new Set();
  const ranges = new Map(rels.map((rel) => [rel, []]));
  const addRange = (rel, range) => ranges.get(rel)?.push(range);
  for (const chapter of chapters) {
    if (chapter.auto) {
      continue; // the bridge's "Not in a chapter yet" tells nothing
    }
    const own = chapter.files.map((entry) => entry.rel);
    for (const entry of chapter.files) {
      const file = diff.get(entry.rel);
      if (!file) {
        continue;
      }
      if (!entry.ref) {
        listed.add(entry.rel);
      }
      const lines = entry.lines || [];
      if (!lines.length && !entry.ref && coveredByListing(file, entry, chapter)) {
        whole.add(entry.rel);
      }
      lines.forEach((range) => addRange(entry.rel, range));
    }
    for (const { rel, lines } of lineRefsOf(textOf(chapter), own, rels)) {
      lines.forEach((range) => addRange(rel, range));
    }
    for (const comment of chapter.comments || []) {
      const rel = commentRel(comment, rels);
      if (rel) {
        const line = Number(comment.line);
        addRange(rel, { side: comment.side === 'L' ? 'L' : 'R', start: line, end: line });
      }
    }
  }
  const out = [];
  for (const file of diff.values()) {
    if (!listed.has(file.rel) || whole.has(file.rel) || file.binary || !file.hunks.length) {
      continue;
    }
    const pointed = ranges.get(file.rel);
    const missed = file.hunks.filter((hunk) => {
      const sides = sidesOf(hunk);
      return !pointed.some((range) => overlaps(range, sides[range.side === 'L' ? 'L' : 'R']));
    });
    if (missed.length) {
      out.push({
        rel: file.rel,
        hunks: missed.map((hunk) => {
          const ref = hunkRef(file.rel, hunk);
          const side = /:L\d/.test(ref) ? 'L' : 'R';
          return { side, ...sidesOf(hunk)[side], ref };
        }),
      });
    }
  }
  return out;
}
