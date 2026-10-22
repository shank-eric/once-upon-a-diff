/*
 * What changed since: the marks on the step list and the file list. They
 * come from two of the bridge's answers: freshness (commits after the story
 * was told, or the ones its last update brought in) and reads (commits after
 * they read a chapter). One renderer draws all three kinds, and each mark's
 * `why` picks its wording.
 *
 * marksOf has no DOM, so node tests can use it.
 */
import { escapeHtml } from '../util/html.js';
import { shortSha } from '../util/text.js';

const range = (mark) => `${shortSha(mark.since)}..${shortSha(mark.until)}`;

/** The wording per why: the file list's tag, the step list's tag, and their hovers. */
const WORDING = {
  story: {
    file: () => 'changed since story',
    fileTitle: () => 'Changed in a commit after the one the story was told from',
    step: () => '• changed since',
    stepTitle: () => 'A file here changed after the story was told',
  },
  update: {
    file: (mark) => `new since ${shortSha(mark.since)}`,
    fileTitle: (mark) => `Changed in ${range(mark)}, the commits the last update brought in`,
    step: () => '• updated',
    stepTitle: (mark) =>
      `A file here changed in ${range(mark)}, the commits the last update brought in`,
  },
  read: {
    file: () => 'changed since you read',
    fileTitle: (mark) =>
      `A newer commit changed it after you read this chapter at ${shortSha(mark.since)}`,
    step: () => '• changed since you read',
    stepTitle: (mark) =>
      `Changed after you read it (at ${shortSha(mark.since)}): ${mark.files.join(', ')}`,
  },
};

/**
 * The marks to draw: [{why, steps, files, since, until, onlyOn}], why 'story' | 'update' | 'read'. A mark lights its
 * steps in the step list and its files in the file list; a read mark's files only on its own step (onlyOn).
 * @param {object|null} fresh opts.freshness()'s answer
 * @param {object|null} reads opts.reads()'s answer
 */
export function marksOf(fresh, reads) {
  const marks = [];
  const change = (why, from, since, until) => ({
    why,
    steps: from.chapters_touched || [],
    files: from.changed_files || [],
    since,
    until,
    onlyOn: null,
  });
  if (fresh && fresh.state === 'stale') {
    marks.push(change('story', fresh, fresh.story_head, fresh.current_head));
  } else if (fresh && fresh.state === 'current' && fresh.updated) {
    marks.push(change('update', fresh.updated, fresh.updated.from, fresh.updated.to));
  }
  for (const read of (reads && reads.changed) || []) {
    marks.push({
      why: 'read',
      steps: [read.step],
      files: read.files || [],
      since: read.since,
      until: null,
      onlyOn: read.step,
    });
  }
  return marks;
}

export function createMarks(context) {
  const { state, shell } = context;

  const tag = (mark, where) => {
    const words = WORDING[mark.why];
    const title = where === 'file' ? words.fileTitle(mark) : words.stepTitle(mark);
    const text = where === 'file' ? words.file(mark) : words.step(mark);
    return `<span class="prs-chg" data-why="${mark.why}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
  };

  function render() {
    for (const el of shell.root.querySelectorAll('.prs-chg')) {
      el.remove();
    }
    const marks = marksOf(context.freshness.current, context.reading.info);
    for (const item of shell.root.querySelectorAll('ol.prs-map li[data-n]')) {
      const step = Number(item.getAttribute('data-n'));
      for (const mark of marks.filter((candidate) => candidate.steps.includes(step))) {
        item.insertAdjacentHTML('beforeend', tag(mark, 'step'));
      }
    }
    const here = marks.filter((mark) => mark.onlyOn === null || mark.onlyOn === state.n);
    for (const item of shell.root.querySelectorAll('ul.prs-files > li[data-file]')) {
      const rel = item.getAttribute('data-file');
      for (const mark of here.filter((candidate) => candidate.files.includes(rel))) {
        item.querySelector('code').insertAdjacentHTML('afterend', tag(mark, 'file'));
      }
    }
  }

  return { render };
}
