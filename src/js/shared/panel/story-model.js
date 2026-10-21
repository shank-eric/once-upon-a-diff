/*
 * The story as the panel reads it: chapters and their numbers, where each
 * file is finished (marked viewed), and the backstory view's steps. No DOM
 * here, so node tests can use it.
 *
 * Steps: 0 is the Overview (story map, every file, no filter), then 1..N are
 * the chapters. A story map at the top of a chapter's narrative, before its
 * "Chapter N" heading, is moved to the Overview.
 *
 * "Since you read it" chapters (a chapter with `since: {from, to}`) tell the
 * commits that came after the reviewer read the story, and come first. They
 * aren't numbered: the chapters after them keep the numbers they were read
 * with. A file one of them lists is marked viewed there (the newest one wins),
 * since the chapters after it were already read.
 */

/** A chapter's stable key, as the bridge's read.json uses it: its `key`, else its title without "Chapter N:". */
export function chapterKeyOf(chapter) {
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
export function finishedInOf(chapters) {
  const finishedIn = {};
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
export function chapterNumbers(chapters) {
  let count = 0;
  return chapters.map((chapter) => (chapter.since ? null : ++count));
}

const CHAPTER_HEADING = /^#{1,6}\s+Chapter\s+\d+\b/m;

/** Moves a story map at the top of a chapter's narrative to the Overview. Returns the Overview's markdown. */
function takeStoryMap(data) {
  let overview = data.overview || '';
  for (const chapter of data.chapters) {
    const text = chapter.narrative || '';
    const heading = CHAPTER_HEADING.exec(text);
    const before = heading ? text.slice(0, heading.index) : '';
    if (before.trim() && /story map/i.test(before)) {
      if (!overview) {
        overview = before.trim();
      }
      chapter.narrative = text.slice(heading.index);
    }
  }
  return overview;
}

/** The backstory view's steps, one per moment of work, shaped like chapters. */
function backstoryStepsOf(timeline, allPaths) {
  return timeline.map((moment, index) => ({
    title: `${index + 1}. ${moment.title || 'Work'}`,
    narrative: '',
    entry: moment,
    files: (moment.files || [])
      .filter((rel) => allPaths.has(rel))
      .map((rel) => {
        const ranges = (moment.lines && moment.lines[rel]) || [];
        const entry = { rel, partial: false, note: null };
        if (ranges.length) {
          entry.lines = ranges.slice(0, 4).map(([start, end]) => ({
            side: 'R',
            start,
            end: end || start,
            label: 'changed here',
          }));
        }
        return entry;
      }),
    comments: [],
  }));
}

/**
 * The panel's read-only view of a story (a deep copy of the input, with the story map moved to the Overview).
 * Steps are 1-based chapter indexes; 0 is the Overview.
 */
export function createStoryModel(input) {
  const data = JSON.parse(JSON.stringify(input));
  const shaToPath = new Map(data.files.map((file) => [file.sha, file.rel]));
  const pathToSha = new Map(data.files.map((file) => [file.rel, file.sha]));
  const allPaths = new Set(data.files.map((file) => file.rel));
  const allRels = data.files.map((file) => file.rel);
  const overviewMarkdown = takeStoryMap(data);

  // A file is marked viewed in the LAST chapter that lists it, whether or not the earlier listings say partial,
  // or in the "Since you read it" chapter that lists it. Every earlier chapter leaves it untagged: no pill, no status line.
  const finishedIn = finishedInOf(data.chapters);
  const numbers = chapterNumbers(data.chapters);
  const isNew = (step) => !!(data.chapters[step - 1] && data.chapters[step - 1].since);
  const chapterNumber = (step) => numbers[step - 1];
  const newTitle = (step) =>
    String(data.chapters[step - 1].title || 'Since you read it')
      .replace(/:.*$/, '')
      .trim();
  /** "chapter 3", or "Since you read it" for a new-commits chapter */
  const chapterName = (step) =>
    isNew(step) ? `“${newTitle(step)}”` : `chapter ${chapterNumber(step)}`;
  const chapterShortName = (step) => (isNew(step) ? 'new' : `ch ${chapterNumber(step)}`);
  const chapterList = (steps) =>
    steps.map((step) => (isNew(step) ? 'new' : chapterNumber(step))).join(', ');
  const chaptersOf = (rel) =>
    data.chapters
      .map((chapter, index) => (chapter.files.some((file) => file.rel === rel) ? index + 1 : 0))
      .filter(Boolean);

  /** What chapter `step` tells the reviewer about a file it lists: mark it viewed here, done earlier, or later's to mark. */
  function statusIn(rel, step) {
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
    return { kind: 'mark', text: 'Mark viewed', short: 'mark viewed' };
  }

  // the backstory: the chronological view's steps, one per moment of work
  const backstory = data.backstory && typeof data.backstory === 'object' ? data.backstory : null;
  const timeline =
    backstory && Array.isArray(backstory.timeline)
      ? backstory.timeline.filter((moment) => moment && (moment.title || moment.text))
      : [];
  const sessions = new Map(
    ((backstory && backstory.sessions) || []).map((session) => [session.id, session]),
  );

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
    backstory,
    timeline,
    backstorySteps: backstoryStepsOf(timeline, allPaths),
    sessions,
  };
}
