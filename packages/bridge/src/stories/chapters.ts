// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * A story's chapters as the panel takes them: each chapter's key, text, file
 * entries, drafted comments and "Since you read it" range, and a last chapter
 * for any file of the diff no chapter places.
 */
import { chapterKeyOf } from '@once-upon-a-diff/shared/panel/story-model';
import { SHA_RE } from '@once-upon-a-diff/shared/util/text';

/**
 * A "Since you read it" chapter's `since`: {from, to, commits}, the commits it tells (from..to).
 * The panel numbers chapters after it, puts "Mark viewed" on its files, and links GitHub's diff of just that range.
 */
export function sinceOfChapter(since) {
  if (
    !since ||
    typeof since !== 'object' ||
    !SHA_RE.test(String(since.from || '')) ||
    !SHA_RE.test(String(since.to || ''))
  ) {
    return null;
  }
  return {
    from: since.from,
    to: since.to,
    commits: Number.isInteger(since.commits) && since.commits >= 0 ? since.commits : null,
  };
}

/** A chapter's file entry: a path, or {rel, partial, note, lines, whole}. */
export function entryOf(entry) {
  if (typeof entry === 'string') {
    return { rel: entry, partial: false, note: null };
  }
  const out = { rel: entry.rel, partial: !!entry.partial, note: entry.note || null };
  if (entry.whole) {
    out.whole = true; // this chapter tells all of the file's hunks (hunk-coverage.mjs)
  }
  if (Array.isArray(entry.lines) && entry.lines.length) {
    out.lines = entry.lines.map((range) => ({
      side: range.side === 'L' ? 'L' : 'R',
      start: +range.start,
      end: +(range.end || range.start),
      label: range.label || '',
    }));
  }
  return out;
}

/** chapters.json's chapters, normalized. */
export function chaptersOf(plan) {
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
        ...(comment.side === 'L' ? { side: 'L' } : {}), // a comment on a removed line
        // a rebuild kept it from the earlier telling: its line is still in the diff (carried) or isn't (unmapped)
        ...(comment.carried ? { carried: true } : {}),
        ...(comment.unmapped ? { unmapped: true } : {}),
      })),
      ...(since ? { since } : {}),
    };
  });
}

/** Anything in the diff that no chapter places goes in a last chapter, so no file is hidden from every step. */
export function addLeftoverChapter(chapters, rels) {
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
