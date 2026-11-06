/*
 * The pure parts of how a story's chapters are read, shared by the panel and the bridge: a chapter's stable key, where each
 * file is finished (marked viewed), and each chapter's number. They take just the fields they read, so the bridge can pass
 * chapters.json's own. No imports: the domain sits below the wire types.
 *
 * "Since you read it" chapters (a chapter with `since: {from, to}`) tell the commits that came after the reviewer read the
 * story, and come first. They aren't numbered: the chapters after them keep the numbers they were read with. A file one of
 * them lists is marked viewed there (the newest one wins), since the chapters after it were already read.
 */

/** Just what the pure helpers read of a chapter, so the bridge can pass chapters.json's own. */
export interface ChapterFiles {
  files?: { rel: string }[];
  since?: unknown;
}

/** A chapter's stable key, as the bridge's read.json uses it: its `key`, else its title without "Chapter N:". */
export function chapterKeyOf(
  chapter: { key?: unknown; title?: unknown } | null | undefined,
): string {
  if (chapter && typeof chapter.key === 'string' && chapter.key.trim()) {
    return chapter.key.trim().slice(0, 200);
  }
  return String((chapter && chapter.title) || '')
    .replace(/^\s*chapter\s+\d+\s*[:.–—-]\s*/i, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * Where each file is marked viewed: the LAST chapter that lists it (earlier ones leave it untagged),
 * except that a "Since you read it" chapter (one with `since`) finishes its files, the newest (first) one winning.
 */
export function finishedInOf(chapters: ChapterFiles[]): Record<string, number> {
  const finishedIn: Record<string, number> = {};
  chapters.forEach((chapter, index) =>
    (chapter.files || []).forEach((file) => {
      finishedIn[file.rel] = index + 1;
    }),
  );
  for (let index = chapters.length - 1; index >= 0; index--) {
    if (chapters[index].since) {
      (chapters[index].files || []).forEach((file) => {
        finishedIn[file.rel] = index + 1;
      });
    }
  }
  return finishedIn;
}

/** Each step's chapter number, or null for a "Since you read it" chapter: those aren't numbered, so the rest keep the numbers they were read with. */
export function chapterNumbers(chapters: { since?: unknown }[]): (number | null)[] {
  let count = 0;
  return chapters.map((chapter) => (chapter.since ? null : ++count));
}
