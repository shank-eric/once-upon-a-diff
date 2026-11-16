/*
 * Drift of a local story's refs. A ref points at line numbers, so a commit made after the story was told can leave it
 * pointing at other code. When a story is told, `anchors.json` (next to its chapters.json) records one line of text per
 * ref; when it is served, that text is looked up again in the live diff, and a ref whose line no longer has it is
 * marked `moved` ("may have moved": we do not look for where the text went, and do not rewrite the ref).
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { chapterKeyOf } from '@once-upon-a-diff/terms/chapters';
import type { Side } from '@once-upon-a-diff/terms/line-refs';
import type { Chapter, ChapterRef, DiffFile } from '@once-upon-a-diff/contracts/types';
import { refOf, type Plan, type PlanRef } from './chapters.ts';
import { canonical, keptChapters } from './validate.ts';

export const ANCHORS_FILE = 'anchors.json';

/** the line of text a ref was told over: `place` is the ref's path, side and lines, so an edited ref is not compared */
export interface Anchor {
  place: string;
  line: number;
  text: string;
}

export interface Anchors {
  overview: Record<string, Anchor>;
  /** by chapter key, then ref id */
  chapters: Record<string, Record<string, Anchor>>;
}

/** how many lines from the start of a ref are looked at for a line with real text */
const SCAN = 8;

const normalise = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 200);

const placeOf = (ref: ChapterRef) =>
  ref.start === undefined
    ? null
    : [ref.path, '@', ref.side ?? 'R', ':', ref.start, '-', ref.end].join('');

/** A line of the diff's text (normalised) by its number on `side`, or null when no hunk shows that line. */
export function lineTextAt(file: DiffFile, side: Side, line: number): string | null {
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const text of hunk.lines) {
      const mark = text[0];
      if (mark === '\\') {
        continue; // "No newline at end of file": on neither side
      }
      const onOld = mark !== '+';
      const onNew = mark !== '-';
      if (side === 'L' ? onOld && oldLine === line : onNew && newLine === line) {
        return normalise(text.slice(1));
      }
      oldLine += onOld ? 1 : 0;
      newLine += onNew ? 1 : 0;
    }
  }
  return null;
}

/**
 * The anchor of a ref: the first line within its first 8 that the diff shows and that has real text (a blank, `}` or
 * `});` matches by chance after almost any shift, and a hunk ref starts on a context line). Null for a ref with no lines
 * (a file cannot drift) or none to anchor on.
 */
export function anchorFor(ref: PlanRef, diff: Map<string, DiffFile>): Anchor | null {
  const made = refOf(ref);
  const place = placeOf(made);
  const file = diff.get(made.path);
  if (!place || !file) {
    return null;
  }
  for (let line = made.start!; line <= Math.min(made.end!, made.start! + SCAN - 1); line++) {
    const text = lineTextAt(file, made.side ?? 'R', line);
    if (text !== null && (text.match(/[\p{L}\p{N}]/gu) || []).length >= 3) {
      return { place, line, text };
    }
  }
  return null;
}

function refAnchors(
  refs: PlanRef[] | undefined,
  diff: Map<string, DiffFile>,
  kept: boolean,
  previous: Record<string, Anchor> | undefined,
): Record<string, Anchor> {
  const out: Record<string, Anchor> = {};
  for (const ref of refs || []) {
    const made = refOf(ref);
    const place = placeOf(made);
    if (!place) {
      continue;
    }
    // a kept chapter is text nobody touched: its anchor is from when it was told (or none: a diff that may have drifted
    // since is no baseline). A new or retold chapter was just written over the diff as it is.
    const before = previous?.[made.id];
    const keep = before?.place === place ? before : null;
    const anchor = kept ? keep : anchorFor(ref, diff);
    if (anchor) {
      out[made.id] = anchor;
    }
  }
  return out;
}

/** The plan's overview text and the refs it links by: kept when the served plan has the same. */
const overviewOf = (plan: Plan) =>
  canonical({ overview: plan.overview, summary: plan.summary, plan: plan.plan, refs: plan.refs });

/**
 * The anchors of a plan just told, over the diff it was told for. `served` is the plan being replaced and `previous` its
 * anchors.
 */
export function anchorsFor(
  plan: Plan,
  diff: Map<string, DiffFile>,
  previous: Anchors | null,
  served: Plan | null,
): Anchors {
  const kept = keptChapters(plan, served);
  const chapters: Anchors['chapters'] = {};
  (plan.chapters || []).forEach((chapter, i) => {
    const key = chapterKeyOf(chapter);
    chapters[key] = refAnchors(chapter.refs, diff, kept[i], previous?.chapters?.[key]);
  });
  const sameOverview = !!served && overviewOf(plan) === overviewOf(served);
  return {
    overview: refAnchors(plan.refs, diff, sameOverview, previous?.overview),
    chapters,
  };
}

/**
 * Sets `moved` on the refs a story is served with whose anchored line the live diff no longer has there: its text
 * differs, or no hunk shows it. A ref with no anchor, or one for other lines than it has now, is unknown, not moved. It
 * also marks the file entries' `lines` made from the ref.
 */
export function movedRefs(
  chapters: Chapter[],
  overviewRefs: ChapterRef[],
  anchors: Anchors,
  diff: Map<string, DiffFile>,
): void {
  const moved = (ref: ChapterRef, anchor: Anchor | undefined) => {
    const file = diff.get(ref.path);
    if (!anchor || !file || anchor.place !== placeOf(ref)) {
      return false;
    }
    return lineTextAt(file, ref.side ?? 'R', anchor.line) !== anchor.text;
  };
  for (const ref of overviewRefs) {
    if (moved(ref, anchors.overview?.[ref.id])) {
      ref.moved = true;
    }
  }
  for (const chapter of chapters) {
    const mine = anchors.chapters?.[chapter.key];
    for (const ref of chapter.refs) {
      if (!moved(ref, mine?.[ref.id])) {
        continue;
      }
      ref.moved = true;
      for (const file of chapter.files) {
        for (const lines of file.lines || []) {
          if (
            file.rel === ref.path &&
            lines.side === (ref.side ?? 'R') &&
            lines.start === ref.start &&
            lines.end === ref.end
          ) {
            lines.moved = true;
          }
        }
      }
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A story folder's anchors; none when there is no file or it is not one of ours. */
export function readAnchors(dir: string): Anchors | null {
  const found = readJson<unknown>(path.join(dir, ANCHORS_FILE), null);
  return isRecord(found) && isRecord(found.overview) && isRecord(found.chapters)
    ? (found as unknown as Anchors)
    : null;
}

export function writeAnchors(dir: string, anchors: Anchors): void {
  writeJsonAtomic(path.join(dir, ANCHORS_FILE), anchors);
}
