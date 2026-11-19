/*
 * Every hunk of the diff should be told by some chapter, not only every file.
 *
 * A chapter covers a hunk when something in it points at a line inside that
 * hunk (its context lines count): a ref of the chapter with lines (`refs`),
 * or a drafted comment on that line, at the file's full path. Text covers
 * nothing: a `path:40-58` in a narrative is not a pointer. `L` refs and
 * comments are checked against the hunk's old side, the rest against its new
 * side. A ref counts only when the chapter's own text links it (`[text](ref:id)`): a ref nothing links shows the reader
 * nothing. A chapter with no narrative yet (the skeleton), a "Since you read it" chapter, and a chapter the story
 * keeps as it was published count all their refs.
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
import type { Side } from '@once-upon-a-diff/terms/line-refs';
import { formatLineRef, refIdsIn, toSide } from '@once-upon-a-diff/terms/line-refs';
import { textOf } from './text-refs.ts';

export const SMALL_FILE_LINES = 40;
/** A file an entry marks `"whole"` past this many changed lines is told thinly: one chapter says all of it. */
export const WHOLE_WARN_LINES = 300;
/** A hunk this long (on the side its ref names) that the chapter's pointers barely touch is told thinly. */
export const BIG_HUNK_LINES = 60;
/** The least a big hunk's pointers should cover, as a share of its lines. */
const THIN_SHARE = 0.1;
export const LOCKFILES =
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
function hunkRef(rel: string, hunk: DiffHunk): string {
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

/** How a story's pointers are counted: `linked` counts a ref only when its chapter links it; `kept` marks (by index) the chapters left as published, which count every ref. */
export interface CoverageOptions {
  linked?: boolean;
  kept?: boolean[];
}

/** The refs of a chapter that count as pointers: all of them, or (linked) the ones its text links. */
function countedRefs(chapter: Chapter, index: number, options: CoverageOptions): Chapter['refs'] {
  const noLinkedText = chapter.since || chapter.auto || !chapter.narrative.trim();
  if (!options.linked || options.kept?.[index] || noLinkedText) {
    return chapter.refs;
  }
  const linked = new Set(refIdsIn(textOf(chapter)));
  // a hunk the chapter lists by id (`hunks`) was named by the chapter, so it counts without a link
  return chapter.refs.filter((ref) => ref.hunk || linked.has(ref.id));
}

/** What the chapters point at, per file: the entries that tell all of it, and the line ranges of the pointers. */
function pointersOf(chapters: Chapter[], diff: Map<string, DiffFile>, options: CoverageOptions) {
  const rels = [...diff.keys()];
  const listed = new Set<string>();
  const whole = new Set<string>();
  const marked = new Set<string>(); // the entries that say "whole": true
  const ranges = new Map<string, LineSpan[]>(rels.map((rel) => [rel, []]));
  const addRange = (rel: string, range: LineSpan) => ranges.get(rel)?.push(range);
  chapters.forEach((chapter, index) => {
    if (chapter.auto) {
      return; // the bridge's "Not in a chapter yet" tells nothing
    }
    const refs = countedRefs(chapter, index, options);
    for (const entry of chapter.files) {
      const file = diff.get(entry.rel);
      if (!file) {
        continue;
      }
      listed.add(entry.rel);
      const pointed = refs.some((ref) => ref.path === entry.rel && ref.start !== undefined);
      if (entry.whole) {
        marked.add(entry.rel);
      }
      if (entry.whole || (!pointed && coveredByListing(file, entry, chapter))) {
        whole.add(entry.rel);
      }
    }
    for (const ref of refs) {
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
  });
  return { listed, whole, marked, ranges };
}

/**
 * The hunks no chapter covers: [{rel, hunks: [{side, start, end, ref}]}] in diff order. chapters are chapters.json's,
 * normalized (chaptersOf).
 */
export function uncoveredHunks(
  chapters: Chapter[],
  diff: Map<string, DiffFile>,
  options: CoverageOptions = {},
): UncoveredFile[] {
  const { listed, whole, ranges } = pointersOf(chapters, diff, options);
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

/** A place the story tells thinly: a whole file past WHOLE_WARN_LINES, or a big hunk its pointers barely touch. */
export interface ThinPlace {
  rel: string;
  /** `path` for a whole file, else the hunk's line reference */
  ref: string;
  kind: 'whole' | 'hunk';
  /** changed lines of the file (whole), or lines of the hunk */
  lines: number;
  /** lines of a hunk the pointers cover */
  covered?: number;
}

/**
 * Where the story is told thinly. A `"whole": true` entry on a file of more than WHOLE_WARN_LINES changed lines says one
 * chapter tells all of it. A hunk of BIG_HUNK_LINES or more that the counted pointers (linked refs, comments) cover under
 * a tenth of is told by a ref on a line or two. Two refs on one hunk count together; a file told whole is reported by the
 * first rule only, and a hunk nothing points at is uncovered, not thin.
 */
export function thinHunks(
  chapters: Chapter[],
  diff: Map<string, DiffFile>,
  options: CoverageOptions = {},
): ThinPlace[] {
  const { listed, whole, marked, ranges } = pointersOf(chapters, diff, options);
  const out: ThinPlace[] = [];
  for (const file of diff.values()) {
    if (!listed.has(file.rel) || file.binary) {
      continue;
    }
    if (marked.has(file.rel)) {
      const place = thinWholeFile(file);
      if (place) {
        out.push(place);
      }
    } else if (!whole.has(file.rel)) {
      for (const hunk of file.hunks) {
        const place = thinHunkOf(file.rel, hunk, ranges.get(file.rel)!);
        if (place) {
          out.push(place);
        }
      }
    }
  }
  return out;
}

/** A file marked whole that is more than WHOLE_WARN_LINES changed lines, as a thin place. */
function thinWholeFile(file: DiffFile): ThinPlace | null {
  const changed = file.stats.added + file.stats.removed;
  return changed > WHOLE_WARN_LINES
    ? { rel: file.rel, ref: file.rel, kind: 'whole', lines: changed }
    : null;
}

/** The lines of a hunk's side that the ranges on that side point at. */
function touchedLines(ranges: LineSpan[], side: Side, span: { start: number; end: number }) {
  const touched = new Set<number>();
  for (const range of ranges.filter((one) => toSide(one.side) === side)) {
    for (
      let line = Math.max(range.start, span.start);
      line <= Math.min(range.end, span.end);
      line++
    ) {
      touched.add(line);
    }
  }
  return touched;
}

/** A big hunk that something points at, but under THIN_SHARE of it, as a thin place; null for any other hunk. */
function thinHunkOf(rel: string, hunk: DiffHunk, fileRanges: LineSpan[]): ThinPlace | null {
  const ref = hunkRef(rel, hunk);
  const side: Side = /:L\d/.test(ref) ? 'L' : 'R';
  const sides = sidesOf(hunk);
  const span = sides[side];
  const lines = span.end - span.start + 1;
  if (lines < BIG_HUNK_LINES) {
    return null;
  }
  const pointed = fileRanges.filter((range) => overlaps(range, sides[toSide(range.side)]));
  if (!pointed.length) {
    return null; // uncovered
  }
  const touched = touchedLines(pointed, side, span);
  return touched.size < lines * THIN_SHARE
    ? { rel, ref, kind: 'hunk', lines, covered: touched.size }
    : null;
}
