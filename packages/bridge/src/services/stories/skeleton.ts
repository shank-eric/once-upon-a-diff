/*
 * A story told chapter by chapter is published first as a skeleton, with every chapter's narrative empty, so the bridge
 * keeps two facts about it that chapters.json alone doesn't say:
 *
 *   skeleton.json   the keys of chapters that were ever published without their text (in the story's served folder).
 *                   The panel doesn't infer a read for such a chapter from Viewed ticks made while it was being
 *                   written, since the text was never on screen then.
 *   unwrittenCount  how many chapters have no text now, for the board and Approve.
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../adapters/stores/json-file.ts';
import { chaptersOf, markUnwritten, type Plan } from './chapters.ts';

const file = (dir: string) => path.join(dir, 'skeleton.json');

/** The chapters of `plan` that have no text yet, as the panel counts them (markUnwritten), without the leftover chapter. */
function unwrittenOf(plan: Plan) {
  const chapters = chaptersOf(plan);
  markUnwritten(chapters, plan);
  return chapters.filter((chapter) => chapter.unwritten);
}

/** Records the keys of the plan's chapters that have no text yet, next to the story's served chapters.json. Keeps the ones already recorded. */
export function noteSkeleton(dir: string, plan: Plan): void {
  const keys = unwrittenOf(plan).map((chapter) => chapter.key);
  if (!keys.length) {
    return;
  }
  const known = readJson<string[]>(file(dir), []) || [];
  const all = [...new Set([...known, ...keys])];
  if (all.length !== known.length) {
    writeJsonAtomic(file(dir), all);
  }
}

/** The keys of chapters that were published without their text at some point. */
export function skeletonKeys(dir: string): Set<string> {
  const keys = readJson<unknown>(file(dir), []);
  return new Set(
    Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
  );
}

/** How many chapters of the story served from `dir` have no text yet. */
export function unwrittenCount(dir: string): number {
  return unwrittenOf(readJson<Plan>(path.join(dir, 'chapters.json'), {}) || {}).length;
}
