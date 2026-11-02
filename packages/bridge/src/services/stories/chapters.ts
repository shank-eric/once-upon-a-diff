/*
 * A story's chapters as the panel takes them: each chapter's key, text, file
 * entries, drafted comments and "Since you read it" range, and a last chapter
 * for any file of the diff no chapter places.
 */
import { chapterKeyOf } from '@once-upon-a-diff/shared/util/story-model';
import { SHA_RE } from '@once-upon-a-diff/shared/util/text';
import type {
  Chapter,
  ChapterFile,
  DraftComment,
  SinceRange,
} from '@once-upon-a-diff/shared/types';

/** A file entry in chapters.json as the story was written: a path, or the fields entryOf reads. */
export type PlanFile =
  | string
  | {
      rel: string;
      partial?: unknown;
      note?: string | null;
      whole?: unknown;
      lines?: { side?: string; start: number | string; end?: number | string; label?: string }[];
    };

/** A chapter in chapters.json as the story was written (chaptersOf normalizes it). */
export interface PlanChapter {
  key?: unknown;
  title?: string;
  headline?: string;
  scenario?: string;
  summary?: string;
  narrative?: string;
  files?: PlanFile[];
  comments?: (Partial<DraftComment> & { side?: string })[];
  since?: unknown;
}

/** chapters.json: the story as once-upon (or `once-upon local`) wrote it. */
export interface Plan {
  mode?: string;
  title?: string;
  overview?: string;
  summary?: string;
  plan?: string;
  chapters?: PlanChapter[];
}

/**
 * A "Since you read it" chapter's `since`: {from, to, commits}, the commits it tells (from..to).
 * The panel numbers chapters after it, puts "Mark viewed" on its files, and links GitHub's diff of just that range.
 */
export function sinceOfChapter(since: unknown): SinceRange | null {
  const range = since as { from?: string; to?: string; commits?: number } | null;
  if (
    !range ||
    typeof range !== 'object' ||
    !SHA_RE.test(String(range.from || '')) ||
    !SHA_RE.test(String(range.to || ''))
  ) {
    return null;
  }
  return {
    from: range.from as string,
    to: range.to as string,
    commits:
      Number.isInteger(range.commits) && (range.commits as number) >= 0
        ? (range.commits as number)
        : null,
  };
}

/** A chapter's file entry: a path, or {rel, partial, note, lines, whole}. */
export function entryOf(entry: PlanFile): ChapterFile {
  if (typeof entry === 'string') {
    return { rel: entry, partial: false, note: null };
  }
  const out: ChapterFile = { rel: entry.rel, partial: !!entry.partial, note: entry.note || null };
  if (entry.whole) {
    out.whole = true; // this chapter tells all of the file's hunks (hunk-coverage.ts)
  }
  if (Array.isArray(entry.lines) && entry.lines.length) {
    out.lines = entry.lines.map((range) => ({
      side: range.side === 'L' ? ('L' as const) : ('R' as const),
      start: +range.start,
      end: +(range.end || range.start),
      label: range.label || '',
    }));
  }
  return out;
}

/** chapters.json's chapters, normalized. */
export function chaptersOf(plan: Plan): Chapter[] {
  return (plan.chapters || []).map((chapter) => {
    const since = sinceOfChapter(chapter.since);
    return {
      key: chapterKeyOf(chapter), // what read.json records a read under
      title: chapter.title || '',
      headline: chapter.headline || '',
      scenario: chapter.scenario || '',
      summary: chapter.summary || '',
      narrative: chapter.narrative || '',
      files: (chapter.files || []).map(entryOf),
      comments: (chapter.comments || []).map((comment) => ({
        path: comment.path || '',
        line: comment.line || 0,
        body: comment.body || '',
        ...(comment.side === 'L' ? { side: 'L' as const } : {}), // a comment on a removed line
        // a rebuild kept it from the earlier telling: its line is still in the diff (carried) or isn't (unmapped)
        ...(comment.carried ? { carried: true } : {}),
        ...(comment.unmapped ? { unmapped: true } : {}),
      })),
      ...(since ? { since } : {}),
    };
  });
}

/**
 * A story is published as a skeleton first (the plan: titles, headlines, files), then chapter by chapter. A chapter
 * with no narrative yet is `unwritten`: the panel says it's being written and holds its Mark viewed. Not the leftover
 * chapter, a "Since you read it" chapter, or any chapter of a by-folder story (a fallback whose text never comes).
 */
export function markUnwritten(chapters: Chapter[], plan: { mode?: string }): void {
  if (plan.mode === 'by-folder') {
    return;
  }
  for (const chapter of chapters) {
    if (!chapter.narrative.trim() && !chapter.auto && !chapter.since) {
      chapter.unwritten = true;
    }
  }
}

/** Anything in the diff that no chapter places goes in a last chapter, so no file is hidden from every step. */
export function addLeftoverChapter(chapters: Chapter[], rels: string[]): void {
  const placed = new Set(chapters.flatMap((chapter) => chapter.files.map((file) => file.rel)));
  const unplaced = rels.filter((rel) => !placed.has(rel));
  if (!unplaced.length) {
    return;
  }
  chapters.push({
    key: 'not in a chapter yet',
    title: `Chapter ${chapters.length + 1}: Not in a chapter yet`,
    headline: '',
    scenario: '',
    summary: '',
    narrative: `### Chapter ${chapters.length + 1}: Not in a chapter yet\n\nThe story doesn't place these ${unplaced.length} files. They're here so nothing in the diff is missed.`,
    files: unplaced.map((rel) => ({ rel, partial: false, note: null })),
    comments: [],
    auto: true,
  });
}
