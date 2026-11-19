/*
 * What the build refuses about how a story places its files, as pure functions the build gate and the quality checks share.
 */
import type { Chapter, DiffFile, UncoveredFile } from '@once-upon-a-diff/contracts/types';
import { finishedInOf } from '@once-upon-a-diff/terms/chapters';
import { chaptersOf, type Plan } from './chapters.ts';
import { keptChapters } from './validate.ts';
import { SMALL_FILE_LINES, uncoveredHunks } from './hunk-coverage.ts';

/**
 * The files whose telling is never finished: the chapter that finishes a file (the last to list it, or the newest "Since
 * you read it" one that does: finishedInOf) lists it as partial. `index` is that chapter's place in `chapters`.
 */
export function unfinishedPartials(
  chapters: Chapter[],
  diff: Map<string, DiffFile>,
): { rel: string; index: number }[] {
  const finishedIn = finishedInOf(chapters);
  const out: { rel: string; index: number }[] = [];
  for (const [rel, step] of Object.entries(finishedIn)) {
    const entries = chapters[step - 1].files.filter((entry) => entry.rel === rel);
    if (diff.has(rel) && entries.length && entries[entries.length - 1].partial) {
      out.push({ rel, index: step - 1 });
    }
  }
  return out;
}

/** The line for one unfinished partial; `chapter` is how the caller names the chapter ("chapter 2"). */
export const partialMessage = (rel: string, chapter: string) =>
  `${rel} is partial in ${chapter}, the last chapter that lists it, so no chapter finishes it`;

/** The build's problems for files left partial: one line each, by the chapter's step number. */
export function partialProblems(chapters: Chapter[], diff: Map<string, DiffFile>): string[] {
  return unfinishedPartials(chapters, diff).map(({ rel, index }) =>
    partialMessage(rel, `chapter ${index + 1}`),
  );
}

/**
 * The build's placement problems for a story over `diff`: a chapter naming a file the diff does not have, a file in no
 * chapter, and a file left partial. `chapters` are chapters.json's, normalized (chaptersOf).
 */
export function placementProblems(chapters: Chapter[], diff: Map<string, DiffFile>): string[] {
  const placed = new Set<string>();
  const problems: string[] = [];
  chapters.forEach((chapter, i) => {
    for (const entry of chapter.files) {
      if (diff.has(entry.rel)) {
        placed.add(entry.rel);
      } else {
        problems.push(`chapter ${i + 1} names ${entry.rel}, which is not in the diff`);
      }
    }
  });
  const missing = [...diff.keys()].filter((rel) => !placed.has(rel));
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  problems.push(...partialProblems(chapters, diff));
  return problems;
}

/** The build's report of hunks no chapter tells, with the ways to fix it. */
export function hunksNotCovered(uncovered: UncoveredFile[]): string {
  const count = uncovered.reduce((sum, file) => sum + file.hunks.length, 0);
  const lines = uncovered.map((file) => `  - ${file.hunks.map((hunk) => hunk.ref).join(', ')}`);
  return [
    `hunks not covered: ${count} in ${uncovered.length} files (bigger than ${SMALL_FILE_LINES} changed lines) that no chapter points at`,
    ...lines,
    "Give the chapter that tells each one a ref on it (`refs`: {id, path, side, start, end}) and link it in the chapter's text ([text](ref:id): a ref the text never links counts for nothing) or a comment on it,",
    'or mark the file\'s entry "whole": true where one chapter tells all of it. --allow-uncovered publishes anyway.',
  ].join('\n');
}

/**
 * What the build's gate finds in a plan: the placement problems and the hunks no chapter tells. A chapter left as it was
 * published (`served`) counts every ref, as the rebuild's vet does. `chapters` and `kept` go on to the build's map.
 */
export function gateCheck(plan: Plan, diff: Map<string, DiffFile>, served?: Plan | null) {
  const chapters = chaptersOf(plan);
  const kept = keptChapters(plan, served);
  return {
    chapters,
    kept,
    problems: placementProblems(chapters, diff),
    uncovered: uncoveredHunks(chapters, diff, { linked: true, kept }),
  };
}

/** The message the build and `local --chapters` refuse with, or null when the gate lets the story through. */
export function gateRefusal(
  found: { problems: string[]; uncovered: UncoveredFile[] },
  { allowMissing = false, allowUncovered = false } = {},
): string | null {
  if (found.problems.length && !allowMissing) {
    return `file placement:\n  - ${found.problems.join('\n  - ')}`;
  }
  if (found.uncovered.length && !allowUncovered) {
    return hunksNotCovered(found.uncovered);
  }
  return null;
}
