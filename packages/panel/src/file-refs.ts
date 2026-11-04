/*
 * Links in the story's text, and the status pill on a file's mention.
 *
 * A link is data: a chapter's `refs` entry has an id, and the text links to it as `[text](ref:<id>)` (markdown.ts). A
 * ref names its file and, when it has lines, a side and a range. A backticked name or `path:40` is plain code. A link
 * to a file's diff (#diff-<sha>R45) names its file by an exact id, so it jumps too.
 *
 * placePills and pillMarker have no DOM, so node tests can use them. The story's text is built as a string
 * (markdown.js), so the html`` markup pill() and refAttrs() return turns into its string there.
 */
import { html, raw } from '@once-upon-a-diff/protocol/domain/html';
import { markViewedButton } from './viewed-button.ts';
import type { LineRef } from '@once-upon-a-diff/protocol/domain/line-refs';
import type { Html } from '@once-upon-a-diff/protocol/domain/html';
import type { ChapterRef } from '@once-upon-a-diff/protocol/types';
import type { PanelContext } from './context.ts';

// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const PILL_MARK = /\u0001(\d+)\u0001/g;
/** The marker left in a chapter story's html for its index-th file mention. */
export const pillMarker = (index: number): string => `\u0001${index}\u0001`;

/**
 * Fills a chapter story's pill markers (pillMarker(i) for the i-th file mention, marks[i] its file) in reading order:
 * a file's last mention gets pillFor(rel), every earlier mention nothing.
 */
export function placePills(
  html: unknown,
  marks: (string | null | undefined)[],
  pillFor: (rel: string) => unknown,
): string {
  const last = new Map<string | null | undefined, number>();
  marks.forEach((rel, index) => {
    last.set(rel, index);
  });
  return String(html).replace(PILL_MARK, (marker, indexText) => {
    const index = Number(indexText);
    const rel = marks[index];
    return rel != null && last.get(rel) === index ? String(pillFor(rel)) : '';
  });
}

/**
 * The data-rel attributes (and data-side/start/end for a line) that make a mention a jump link. role and tabindex
 * put it in the tab order, and the shell turns Enter or Space on it into a click.
 */
export function refAttrs(rel: string, line: LineRef | null | undefined): Html {
  const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
  const attrs = html`data-rel="${rel}" role="link" tabindex="0" title="Scroll to ${rel}${where}"`;
  return line
    ? html`${attrs} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"`
    : attrs;
}

/** The same attributes as props for a node (html`<code ...${refNode(rel, line)}>`). */
export function refNode(rel: string, line: LineRef | null | undefined): Record<string, string> {
  const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
  const props: Record<string, string> = {
    'data-rel': rel,
    role: 'link',
    tabindex: '0',
    title: `Scroll to ${rel}${where}`,
  };
  if (line) {
    props['data-side'] = line.side;
    props['data-start'] = String(line.start);
    props['data-end'] = String(line.end);
  }
  return props;
}

export function createFileRefs(context: PanelContext) {
  const { story, state } = context;
  let linkScope = story.allRels; // the files a diff link can jump to: the step's
  let stepRefs: ChapterRef[] = []; // the refs the step's text links to: the chapter's
  let pilled = new Set(); // files whose pill the story already drew in this step
  let answerPilled = new Set(); // files whose pill an answer has drawn in the answers' current draw
  let pillMarks: string[] | null = null; // while a chapter's story is drawn: each file mention, in reading order

  /** Starts a step's text: its diff links jump among these files, its `ref:` links are these refs, and no pill is drawn yet. */
  function startStep(scope: string[], refs: ChapterRef[] = []) {
    linkScope = scope;
    stepRefs = refs;
    pilled = new Set();
  }
  /** Starts a draw of the answers (all of the dock's): each file gets one pill in it, however often the dock is redrawn in a step. */
  function startAnswers() {
    answerPilled = new Set();
  }
  const inScope = (rel: string) => linkScope.includes(rel);
  /** The step's ref with this id, or null. */
  const refById = (id: string): ChapterRef | null => stepRefs.find((ref) => ref.id === id) || null;
  /** A ref's lines as a jump target (null for a ref to the file). */
  const lineOf = (ref: ChapterRef): LineRef | null =>
    ref.start === undefined
      ? null
      : { side: ref.side === 'L' ? 'L' : 'R', start: ref.start, end: ref.end ?? ref.start };
  /** Draws something whose text links by its own refs (an answer's) with those as the refs, then puts the step's back. */
  function withRefs<T>(refs: ChapterRef[] | undefined, draw: () => T): T {
    const saved = stepRefs;
    stepRefs = refs || [];
    try {
      return draw();
    } finally {
      stepRefs = saved;
    }
  }
  /** The story file a path names, exactly, or null: a draft comment's path is the file's full path. */
  const fileOf = (path: string): string | null => (story.allPaths.has(path) ? path : null);

  /**
   * The status pill on a file's mention. While a chapter's story is drawn (pillMarks set), each mention leaves a
   * marker, and placePills() puts the pill on the file's LAST mention in reading order; earlier mentions get nothing.
   * Elsewhere (an answer), it goes on the first mention of a file in that draw of the answers, unless the story pilled it in this step. A file this chapter finishes
   * gets the Mark viewed button; one a later chapter finishes gets nothing.
   */
  function pill(rel: string): Html | string {
    if (!state.n) {
      return '';
    }
    if (pillMarks) {
      return pillMarker(pillMarks.push(rel) - 1);
    }
    if (pilled.has(rel) || answerPilled.has(rel)) {
      return '';
    }
    answerPilled.add(rel);
    return pillHtml(rel);
  }
  function pillHtml(rel: string): Html | string {
    const status = context.fileStatus(rel, state.n);
    if (!status || status.kind === 'later') {
      return '';
    }
    if (status.kind === 'mark') {
      return markViewedButton(rel, true);
    }
    return html`<span class="ou-pill ou-st-${status.kind}" title="${status.text}">${status.short}</span>`;
  }
  /** A chapter's story with its pill markers filled in: the status on each file's last mention, nothing on the earlier ones. */
  function storyWithPills(draw: () => Html) {
    const marks: string[] = [];
    pillMarks = marks;
    let markup: Html;
    try {
      markup = draw();
    } finally {
      pillMarks = null;
    }
    for (const rel of marks) {
      pilled.add(rel);
    }
    return raw(placePills(markup, marks, pillHtml));
  }

  /** The props for a node that jumps to a file or line when clicked: refNode's, plus the click. */
  function jumpProps(rel: string, line: LineRef | null | undefined): Record<string, unknown> {
    return { ...refNode(rel, line), onClick: jumpClick(rel, line) };
  }
  /** A click that jumps to a file or line (for a node that has its own look). */
  function jumpClick(rel: string, line: LineRef | null | undefined) {
    return () => {
      void context.scroll.jumpTo(rel, line ?? null);
    };
  }

  return {
    startStep,
    startAnswers,
    inScope,
    refById,
    lineOf,
    fileOf,
    withRefs,
    pill,
    storyWithPills,
    jumpProps,
    jumpClick,
  };
}

export type FileRefs = ReturnType<typeof createFileRefs>;
