/*
 * Every hunk of the diff should be told by some chapter, not only every file.
 *
 * A chapter covers a hunk when something in it points at a line inside that
 * hunk (its context lines count): a ref of the chapter with lines (`refs`),
 * or a drafted comment on that line, at the file's full path. Text covers
 * nothing: a `path:40-58` in a narrative is not a pointer. `L` refs and
 * comments are checked against the hunk's old side, the rest against its new
 * side.
 *
 * An entry that says `"whole": true` covers all the file's hunks, with or without refs (the author's call that one
 * chapter tells all of it; its refs are then just jump targets). Listing a file with no line refs covers all its
 * hunks when:
 *   - the file is small (at most SMALL_FILE_LINES changed lines, about a screen)
 *   - the file is deleted, or a lockfile, where pointing at lines says nothing
 *   - the chapter is a "Since you read it" one, which tells every file its commits touched
 * A file no chapter lists isn't reported here: file placement already says so.
 *
 * The once-upon skill's `build` refuses to publish with uncovered hunks, and
 * file-map.json carries any it was told to allow, for the panel's Overview.
 */
import type {
  Chapter,
  ChapterFile,
  DiffFile,
  DiffHunk,
  LineSpan,
  UncoveredFile,
} from '@once-upon-a-diff/contracts/types';
import type { Side } from '@once-upon-a-diff/domain/line-refs';
import { formatLineRef, toSide } from '@once-upon-a-diff/domain/line-refs';

export const SMALL_FILE_LINES = 40;
const LOCKFILES =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|Gemfile\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|bun\.lockb?)$/;

/** A hunk's lines on each side, context included: {L: {start, end}, R: {start, end}}. An empty side is its one anchor line. */
export function sidesOf(
  hunk: Pick<DiffHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>,
): Record<Side, { start: number; end: number }> {
  const span = (start: number, count: number) => ({ start, end: start + Math.max(count, 1) - 1 });
  return { L: span(hunk.oldStart, hunk.oldLines), R: span(hunk.newStart, hunk.newLines) };
}

const overlaps = (range: { start: number; end: number }, side: { start: number; end: number }) =>
  range.start <= side.end && range.end >= side.start;

/** A hunk as a line reference the narrative could use: `path:40-58`, or `path:L12-20` for one that only removes lines. */
export function hunkRef(rel: string, hunk: DiffHunk): string {
  const removesOnly = hunk.lines.every((line) => !line.startsWith('+'));
  const side = removesOnly ? 'L' : 'R';
  const { start, end } = sidesOf(hunk)[side];
  return formatLineRef(rel, { side, start, end });
}

/** Does listing this file, with no line refs, cover all of it? */
function coveredByListing(file: DiffFile, entry: ChapterFile, chapter: Chapter): boolean {
  return (
    !!chapter.since ||
    file.kind === 'deleted' ||
    LOCKFILES.test(file.rel) ||
    file.stats.added + file.stats.removed <= SMALL_FILE_LINES
  );
}

/** The path a drafted comment names when it is on a line of a file of the diff (its full path), or null. */
function commentRel(
  comment: { path?: string; line?: number | string },
  rels: string[],
): string | null {
  const name = String(comment.path || '');
  return name && Number(comment.line) > 0 && rels.includes(name) ? name : null;
}

/**
 * The hunks no chapter covers: [{rel, hunks: [{side, start, end, ref}]}] in diff order. chapters are chapters.json's,
 * normalized (chaptersOf; an older story is upgraded first, legacy.ts).
 */
export function uncoveredHunks(chapters: Chapter[], diff: Map<string, DiffFile>): UncoveredFile[] {
  const rels = [...diff.keys()];
  const listed = new Set<string>();
  const whole = new Set<string>();
  const ranges = new Map<string, LineSpan[]>(rels.map((rel) => [rel, []]));
  const addRange = (rel: string, range: LineSpan) => ranges.get(rel)?.push(range);
  for (const chapter of chapters) {
    if (chapter.auto) {
      continue; // the bridge's "Not in a chapter yet" tells nothing
    }
    for (const entry of chapter.files) {
      const file = diff.get(entry.rel);
      if (!file) {
        continue;
      }
      if (!entry.ref) {
        listed.add(entry.rel);
      }
      // a text reference of an older story covers hunks (below) but never made a listed file need pointing at
      const pointed = chapter.refs.some(
        (ref) => ref.path === entry.rel && ref.start !== undefined && !ref.text,
      );
      if (!entry.ref && (entry.whole || (!pointed && coveredByListing(file, entry, chapter)))) {
        whole.add(entry.rel);
      }
    }
    for (const ref of chapter.refs) {
      if (ref.start !== undefined) {
        addRange(ref.path, {
          side: toSide(ref.side),
          start: ref.start,
          end: ref.end as number,
        });
      }
    }
    for (const comment of chapter.comments || []) {
      const rel = commentRel(comment, rels);
      if (rel) {
        const line = Number(comment.line);
        addRange(rel, { side: toSide(comment.side), start: line, end: line });
      }
    }
  }
  const out: UncoveredFile[] = [];
  for (const file of diff.values()) {
    if (!listed.has(file.rel) || whole.has(file.rel) || file.binary || !file.hunks.length) {
      continue;
    }
    const pointed = ranges.get(file.rel)!; // every file of the diff has its list
    const missed = file.hunks.filter((hunk) => {
      const sides = sidesOf(hunk);
      return !pointed.some((range) => overlaps(range, sides[toSide(range.side)]));
    });
    if (missed.length) {
      out.push({
        rel: file.rel,
        hunks: missed.map((hunk) => {
          const ref = hunkRef(file.rel, hunk);
          const side: Side = /:L\d/.test(ref) ? 'L' : 'R';
          return { side, ...sidesOf(hunk)[side], ref };
        }),
      });
    }
  }
  return out;
}
