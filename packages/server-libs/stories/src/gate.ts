/*
 * What the build refuses about how a story places its files, as pure functions the build gate and the quality checks share.
 */
import type { Chapter, DiffFile } from '@once-upon-a-diff/contracts/types';
import { finishedInOf } from '@once-upon-a-diff/terms/chapters';

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
    // an older story's text pointer (legacy.ts) is no listing: the chapter never named the file, so it is no partial
    const entries = chapters[step - 1].files.filter((entry) => entry.rel === rel && !entry.ref);
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
