/*
 * The story as the panel reads it. No DOM here, so node tests can use it. The pure parts (a chapter's key, where each file is
 * finished, the chapter numbers) are the domain's (protocol/src/domain/chapters.ts), which the bridge reads too.
 *
 * Steps: 0 is the Overview (story map, every file, no filter), then 1..N are
 * the chapters. A story map at the top of a chapter's narrative, before its
 * "Chapter N" heading, is moved to the Overview.
 */
import type { StoryData } from '@once-upon-a-diff/protocol/types';
import { chapterNumbers, finishedInOf } from '@once-upon-a-diff/protocol/domain/chapters';

/** What chapter `step` tells the reviewer about a file it lists. */
export interface FileStatus {
  kind: 'done' | 'later' | 'mark' | 'pending';
  text: string;
  short: string;
}

const CHAPTER_HEADING = /^#{1,6}\s+Chapter\s+\d+\b/m;

/** Moves a story map at the top of a chapter's narrative to the Overview. Returns the Overview's markdown. */
function takeStoryMap(data: StoryData): string {
  let overview = data.overview || '';
  for (const chapter of data.chapters) {
    const text = chapter.narrative || '';
    const heading = CHAPTER_HEADING.exec(text);
    const before = heading ? text.slice(0, heading.index) : '';
    if (before.trim() && /story map/i.test(before)) {
      if (!overview) {
        overview = before.trim();
      }
      chapter.narrative = text.slice(heading!.index); // a story map only comes before a heading
    }
  }
  return overview;
}

/**
 * The panel's read-only view of a story (a deep copy of the input, with the story map moved to the Overview).
 * Steps are 1-based chapter indexes; 0 is the Overview.
 */
export function createStoryModel(input: StoryData) {
  const data: StoryData = JSON.parse(JSON.stringify(input));
  const shaToPath = new Map(data.files.map((file) => [file.sha, file.rel]));
  const pathToSha = new Map(data.files.map((file) => [file.rel, file.sha]));
  const allPaths = new Set(data.files.map((file) => file.rel));
  const allRels = data.files.map((file) => file.rel);
  const overviewMarkdown = takeStoryMap(data);

  // A file is marked viewed in the LAST chapter that lists it, whether or not the earlier listings say partial,
  // or in the "Since you read it" chapter that lists it. Every earlier chapter leaves it untagged: no pill, no status line.
  const finishedIn = finishedInOf(data.chapters);
  const numbers = chapterNumbers(data.chapters);
  const isNew = (step: number): boolean =>
    !!(data.chapters[step - 1] && data.chapters[step - 1].since);
  const chapterNumber = (step: number): number | null => numbers[step - 1];
  const newTitle = (step: number): string =>
    String(data.chapters[step - 1].title || 'Since you read it')
      .replace(/:.*$/, '')
      .trim();
  /** "chapter 3", or "Since you read it" for a new-commits chapter */
  const chapterName = (step: number): string =>
    isNew(step) ? `“${newTitle(step)}”` : `chapter ${chapterNumber(step)}`;
  const chapterShortName = (step: number): string =>
    isNew(step) ? 'new' : `ch ${chapterNumber(step)}`;
  const chapterList = (steps: number[]): string =>
    steps.map((step) => (isNew(step) ? 'new' : chapterNumber(step))).join(', ');
  const chaptersOf = (rel: string): number[] =>
    data.chapters
      .map((chapter, index) => (chapter.files.some((file) => file.rel === rel) ? index + 1 : 0))
      .filter(Boolean);

  /** The ids of the parts a step touches: the Overview's are every part a file of the story is in, a chapter's are its files'. Empty when the repo has no parts file. */
  const partsTouched = (step: number): string[] => {
    const parts = data.parts;
    if (!parts) {
      return [];
    }
    return step ? parts.by_chapter[step - 1] || [] : Object.keys(parts.files);
  };

  /** What chapter `step` tells the reviewer about a file it lists: mark it viewed here, done earlier, or later's to mark. */
  function statusIn(rel: string, step: number): FileStatus | null {
    const entry = step && data.chapters[step - 1].files.find((file) => file.rel === rel);
    if (!entry) {
      return null;
    }
    const finishedAt = finishedIn[rel];
    if (finishedAt != null && finishedAt < step) {
      return {
        kind: 'done',
        text: `Already finished in ${chapterName(finishedAt)}`,
        short: `done in ${chapterShortName(finishedAt)}`,
      };
    }
    if (finishedAt != null && finishedAt > step) {
      return { kind: 'later', text: '', short: '' }; // shown as nothing: it isn't this chapter's to mark
    }
    if (data.chapters[step - 1].unwritten) {
      // the chapter is published but its story isn't written yet: Mark viewed waits for the text
      return {
        kind: 'pending',
        text: 'Mark viewed once the story is written',
        short: 'being written',
      };
    }
    return { kind: 'mark', text: 'Mark viewed', short: 'mark viewed' };
  }

  return {
    data,
    shaToPath,
    pathToSha,
    allPaths,
    allRels,
    overviewMarkdown,
    finishedIn,
    isNew,
    chapterNumber,
    chapterName,
    chapterShortName,
    chapterList,
    chaptersOf,
    statusIn,
    partsTouched,
  };
}

export type StoryModel = ReturnType<typeof createStoryModel>;
