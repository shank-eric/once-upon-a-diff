/*
 * Whether a story's pointers (a chapter's or the overview's refs, a drafted comment) land on lines the page shows: a hunk,
 * on the side the pointer names. One rule for the build gate (validate.ts chapterProblems) and the quality checks
 * (quality.ts pointerFindings), so the two cannot disagree. A pointer off every hunk draws nothing on the diff.
 */
import type { DiffFile } from '@once-upon-a-diff/contracts/types';
import { toSide } from '@once-upon-a-diff/terms/line-refs';
import type { PlanRef } from './chapters.ts';
import { sidesOf } from './hunk-coverage.ts';

/** Whether a comment's line is in one of the file's hunks, on the side it names. */
export function lineInDiff(file: DiffFile, line: number, side: string | undefined): boolean {
  return file.hunks.some((hunk) =>
    side === 'L'
      ? line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1)
      : line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1),
  );
}

/**
 * Whether a ref's lines are on the page: its range overlaps a hunk's lines on the side it names, which is the rule hunk
 * coverage counts a pointer by. A ref with no lines (the whole file) always is.
 */
export function refOnPage(ref: PlanRef, file: DiffFile): boolean {
  if (ref.start === undefined || ref.start === null || ref.start === '') {
    return true;
  }
  const start = Number(ref.start);
  const end = Number(ref.end || ref.start);
  const side = toSide(ref.side);
  return file.hunks.some((hunk) => {
    const lines = sidesOf(hunk)[side];
    return start <= lines.end && Math.max(start, end) >= lines.start;
  });
}

/** The refs that are on lines in no hunk, one line each (without an owner: the caller names it). */
export function offPageRefs(refs: PlanRef[], diff: Map<string, DiffFile>): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const file = diff.get(String(ref.path ?? ''));
    if (file && !refOnPage(ref, file)) {
      const where = `${ref.path}:${ref.side === 'L' ? 'L' : ''}${ref.start}-${ref.end ?? ref.start}`;
      out.push(`ref "${ref.id}" (${where}) is on lines that are in no hunk`);
    }
  }
  return out;
}

/**
 * The drafted comments that are on a line in no hunk, as `path:line`. A comment carried from an earlier telling, or one
 * with no place in the diff any more (unmapped), is skipped, as is one on a file the diff does not have (another check).
 */
export function offPageComments(
  comments: {
    path?: string;
    line?: number | string;
    side?: string;
    carried?: boolean;
    unmapped?: boolean;
  }[],
  diff: Map<string, DiffFile>,
): string[] {
  const out: string[] = [];
  for (const comment of comments) {
    const file = diff.get(String(comment.path ?? ''));
    if (
      file &&
      !comment.carried &&
      !comment.unmapped &&
      !lineInDiff(file, Number(comment.line), comment.side)
    ) {
      out.push(`${comment.path}:${comment.line}`);
    }
  }
  return out;
}
