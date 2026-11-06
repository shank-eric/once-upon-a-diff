/*
 * What changed since: the marks on the step list and the file list (drawn with them, from `stepTags` and `fileTags`). They
 * come from two of the bridge's answers: freshness (commits after the story
 * was told, or the ones its last update brought in) and reads (commits after
 * they read a chapter). One renderer draws all three kinds, and each mark's
 * `why` picks its wording.
 *
 * marksOf has no DOM, so node tests can use it.
 */
import { html } from '/assets/preact.mjs';
import { shortSha } from '@once-upon-a-diff/terms/text';
import type { FreshUpdate, Freshness, ReadInfo } from '@once-upon-a-diff/contracts/types';

/** One "changed since" mark: why, the steps it lights, the files it tags, and the commits. */
export interface ChangeMark {
  why: 'story' | 'update' | 'read';
  steps: number[];
  files: string[];
  since: string | null | undefined;
  until: string | null | undefined;
  /** a read mark tags its files only on its own step */
  onlyOn: number | null;
}
import type { PanelContext } from '../host/context.ts';

const range = (mark: ChangeMark) => `${shortSha(mark.since)}..${shortSha(mark.until)}`;

/** The wording per why: the file list's tag, the step list's tag, and their hovers. */
const WORDING: Record<
  ChangeMark['why'],
  Record<'file' | 'fileTitle' | 'step' | 'stepTitle', (mark: ChangeMark) => string>
> = {
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
 * fresh is opts.freshness()'s answer, reads opts.reads()'s.
 */
export function marksOf(
  fresh: Freshness | null,
  reads: Pick<ReadInfo, 'changed'> | null,
): ChangeMark[] {
  const marks: ChangeMark[] = [];
  const change = (
    why: ChangeMark['why'],
    from: Freshness | FreshUpdate,
    since: string | null | undefined,
    until: string | null | undefined,
  ): ChangeMark => ({
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

export function createMarks(context: PanelContext) {
  const { state, shell } = context;

  const tag = (mark: ChangeMark, where: 'file' | 'step') => {
    const words = WORDING[mark.why];
    const title = where === 'file' ? words.fileTitle(mark) : words.stepTitle(mark);
    const text = where === 'file' ? words.file(mark) : words.step(mark);
    return html`<span class="ou-chg" data-why=${mark.why} title=${title}>${text}</span>`;
  };
  const current = () => marksOf(context.freshness.current, context.reading.info);

  /** The tags on a step's row in the step list, in the order the marks come. */
  const stepTags = (step: number) =>
    current()
      .filter((mark) => mark.steps.includes(step))
      .map((mark) => tag(mark, 'step'));

  /** The tags on a file's row: the marks for this step that name it, the last one first. */
  const fileTags = (rel: string) =>
    current()
      .filter((mark) => mark.onlyOn === null || mark.onlyOn === state.n)
      .filter((mark) => mark.files.includes(rel))
      .map((mark) => tag(mark, 'file'))
      .reverse();

  /** Draws the tags again (the freshness or the reads changed). */
  function render() {
    shell.redraw();
  }

  return { render, stepTags, fileTags };
}

export type Marks = ReturnType<typeof createMarks>;
