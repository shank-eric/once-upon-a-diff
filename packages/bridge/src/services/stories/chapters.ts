/*
 * A story's chapters as the panel takes them: each chapter's key, text, file
 * entries, drafted comments and "Since you read it" range, and a last chapter
 * for any file of the diff no chapter places.
 */
import { chapterKeyOf } from '@once-upon-a-diff/domain/chapters';
import { SHA_RE } from '@once-upon-a-diff/domain/text';
import type {
  Chapter,
  ChapterFile,
  ChapterRef,
  DraftComment,
  SinceRange,
} from '@once-upon-a-diff/protocol/types';
import { toSide } from '@once-upon-a-diff/domain/line-refs';

/** A ref in chapters.json as the story was written (refOf normalizes it). */
export interface PlanRef {
  id?: unknown;
  path?: unknown;
  side?: string;
  start?: number | string;
  end?: number | string;
  label?: string;
  /** an older story's text reference, made by legacy.ts */
  text?: boolean;
}

/** A file entry in chapters.json as the story was written: a path, or the fields entryOf reads. `lines` is an older story's. */
export type PlanFile =
  | string
  | {
      rel: string;
      partial?: unknown;
      note?: string | null;
      whole?: unknown;
      ref?: unknown;
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
  /** a short answer once told (≤400 chars) */
  answer?: string;
  files?: PlanFile[];
  /** the places the narrative links to; a plan published now has it on every chapter */
  refs?: PlanRef[];
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
  /** the places the overview, summary and plan link to */
  refs?: PlanRef[];
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
  if (entry.ref) {
    out.ref = true; // an older story: not listed, its text pointed at lines of it (legacy.ts)
  }
  if (entry.whole) {
    out.whole = true; // this chapter tells all of the file's hunks (hunk-coverage.ts)
  }
  if (Array.isArray(entry.lines) && entry.lines.length) {
    out.lines = entry.lines.map((range) => ({
      side: toSide(range.side),
      start: +range.start,
      end: +(range.end || range.start),
      label: range.label || '',
    }));
  }
  return out;
}

/** A ref, normalized: a line range (side R unless it says L, end defaulting to start), or the file when it has no start. */
export function refOf(ref: PlanRef): ChapterRef {
  const out: ChapterRef = { id: String(ref.id ?? ''), path: String(ref.path ?? '') };
  if (ref.start !== undefined && ref.start !== null && ref.start !== '') {
    const start = +ref.start;
    const end = +(ref.end || ref.start);
    out.side = toSide(ref.side);
    out.start = Math.min(start, end);
    out.end = Math.max(start, end);
  }
  if (ref.label) {
    out.label = String(ref.label);
  }
  if (ref.text) {
    out.text = true;
  }
  return out;
}

/** The line ranges of refs that name lines of `rel`, as a chapter's file entry shows them (`lines`). */
function linesOf(refs: ChapterRef[], entry: ChapterFile): ChapterFile['lines'] {
  // an older story's text references only gave lines to a file its text pointed at without listing it
  return refs
    .filter(
      (ref) =>
        ref.path === entry.rel && ref.start !== undefined && (!ref.text || entry.ref === true),
    )
    .map((ref) => ({
      side: toSide(ref.side),
      start: ref.start as number,
      end: ref.end as number,
      label: ref.label || '',
    }));
}

/**
 * chapters.json's chapters, normalized. Each file entry's `lines` are its chapter's refs on that file, so the panel's file
 * list and the local page's narrowing read ranges from one place. A plan with chapters that have no `refs` is an older
 * story: upgrade it first (legacy.ts upgradePlan).
 */
export function chaptersOf(plan: Plan): Chapter[] {
  return (plan.chapters || []).map((chapter) => {
    const since = sinceOfChapter(chapter.since);
    const refs = (chapter.refs || []).map(refOf);
    return {
      key: chapterKeyOf(chapter), // what read.json records a read under
      title: chapter.title || '',
      headline: chapter.headline || '',
      scenario: chapter.scenario || '',
      summary: chapter.summary || '',
      narrative: chapter.narrative || '',
      files: (chapter.files || []).map((file) => {
        const entry = entryOf(file);
        const lines = linesOf(refs, entry);
        delete entry.lines;
        return lines && lines.length ? { ...entry, lines } : entry;
      }),
      refs,
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
    refs: [],
    comments: [],
    auto: true,
  });
}
