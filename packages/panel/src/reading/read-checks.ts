/*
 * What the reviewer has read, no DOM, so node tests can use it: which chapters count as read once the page has shown
 * all their files Viewed (inferReadSteps), and which Viewed files are "viewed early" (viewedEarlyCheck). The panel's
 * reading part (reading.ts) and the Viewed tracker (viewed.ts) both use them.
 */
import { chapterKeyOf } from '@once-upon-a-diff/domain/chapters';
import type { ReadInfo } from '@once-upon-a-diff/contracts/types';

/** How one chapter's files to mark viewed stand (viewed.ts progressOf). */
export interface StepProgress {
  due: number;
  viewed: number;
  unviewed: string[];
  unknown: string[];
  noToggle: boolean;
}

/**
 * Chapters they reviewed before the panel tracked reads (or with the panel closed): every file the chapter marks
 * viewed was already Viewed the first time this page could see all of them, and read.json has no record of it.
 * Only that first look counts, so ticking a later chapter's files while reading an earlier one doesn't read it.
 * progress is progressOf() per step; readInfo the bridge's GET /read (nothing is inferred until it has loaded);
 * firstLook step -> complete at the first look, filled in here. Returns the steps to record as read.
 */
export function inferReadSteps(
  chapters: { key?: unknown; title?: unknown; skeleton?: unknown }[],
  progress: (Pick<StepProgress, 'due' | 'viewed' | 'unknown' | 'noToggle'> | null | undefined)[],
  readInfo: ReadInfo | null,
  firstLook: Map<number, boolean>,
): number[] {
  if (!readInfo || !readInfo.reads) {
    return [];
  }
  const out: number[] = [];
  progress.forEach((stepProgress, index) => {
    const step = index + 1;
    if (
      firstLook.has(step) ||
      chapters[index]?.skeleton || // published before its text: files ticked meanwhile say nothing about the text
      !stepProgress ||
      !stepProgress.due ||
      stepProgress.noToggle ||
      stepProgress.unknown.length
    ) {
      return; // not loaded on the page yet: look again later
    }
    const complete = stepProgress.viewed === stepProgress.due;
    firstLook.set(step, complete);
    if (complete && !readInfo.reads[chapterKeyOf(chapters[index])]) {
      out.push(step);
    }
  });
  return out;
}

/**
 * Which Viewed files are "viewed early" on `step`: those a later chapter finishes, unless they've read that chapter
 * (read.json has its key) and the file hasn't changed since. A chapter that changed only in other files, such as one a
 * "Since you read it" chapter now finishes, still counts as read for the rest. Nothing is early on a "Since you read
 * it" step: it follows up on chapters they've already been through, wherever it sits.
 * readInfo is the bridge's GET /read: {reads, changed: [{step, files}]}.
 */
export function viewedEarlyCheck({
  chapters,
  finishedIn,
  readInfo,
  step,
}: {
  chapters: { key?: unknown; title?: unknown; since?: unknown }[];
  finishedIn: Record<string, number>;
  readInfo: ReadInfo | null;
  step: number;
}): (rel: string) => boolean {
  const reads = (readInfo && readInfo.reads) || {};
  // step -> the files that changed after they read it (null: the bridge didn't say which, so all of them)
  const changed = new Map<number, Set<string> | null>(
    ((readInfo && readInfo.changed) || []).map((change) => [
      change.step,
      Array.isArray(change.files) ? new Set(change.files) : null,
    ]),
  );
  const hasRead = (finishStep: number, rel: string) => {
    const chapter = chapters[finishStep - 1];
    if (!chapter || !reads[chapterKeyOf(chapter)]) {
      return false;
    }
    if (!changed.has(finishStep)) {
      return true;
    }
    const files = changed.get(finishStep);
    return !!files && !files.has(rel);
  };
  const current = chapters[step - 1];
  return (rel) =>
    step > 0 &&
    !!current &&
    !current.since &&
    finishedIn[rel] != null &&
    finishedIn[rel] > step &&
    !hasRead(finishedIn[rel], rel);
}
