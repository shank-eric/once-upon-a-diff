// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * File and line references in the story's text, and the status pill on a
 * file's mention.
 *
 * A backticked name is a file when it is a PR path, a path suffix such as
 * `Combobox/component.tsx`, or a basename, among the files on screen in this
 * step. An ambiguous name goes to the first match in chapter order. A
 * `path:40`, `path:40-58` or `path:L12` suffix makes it a line reference.
 * A bare `:40-58` is a line in the file named last before it in the step,
 * or in the step's only file; it's drawn with that file's name in front.
 *
 * placePills and pillMarker have no DOM, so node tests can use them. The
 * story's text is built as a string (markdown.js), so the html`` markup
 * pill() and refAttrs() return turns into its string there.
 */
import { html, raw, unescapeHtml } from '../util/html.ts';
import { parseLineRef } from '../util/line-refs.ts';
import { markViewedButton } from './viewed.ts';

// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const PILL_MARK = /\u0001(\d+)\u0001/g;
/** The marker left in a chapter story's html for its index-th file mention. */
export const pillMarker = (index) => `\u0001${index}\u0001`;

/**
 * Fills a chapter story's pill markers (pillMarker(i) for the i-th file mention, marks[i] its file) in reading order:
 * a file's last mention gets pillFor(rel), every earlier mention nothing.
 */
export function placePills(html, marks, pillFor) {
  const last = new Map();
  marks.forEach((rel, index) => {
    last.set(rel, index);
  });
  return String(html).replace(PILL_MARK, (marker, indexText) => {
    const index = Number(indexText);
    const rel = marks[index];
    return rel != null && last.get(rel) === index ? pillFor(rel) : '';
  });
}

/**
 * The data-rel attributes (and data-side/start/end for a line) that make a mention a jump link. role and tabindex
 * put it in the tab order, and the shell turns Enter or Space on it into a click.
 */
export function refAttrs(rel, line) {
  const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
  const attrs = html`data-rel="${rel}" role="link" tabindex="0" title="Scroll to ${rel}${where}"`;
  return line
    ? html`${attrs} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"`
    : attrs;
}

export function createFileRefs(context) {
  const { story, state } = context;
  let linkScope = story.allRels; // the files a name can resolve to: the step's
  let pilled = new Set(); // files whose pill is already drawn in this step
  let lastRef = null; // the file a bare `:40` refers to
  let pillMarks = null; // while a chapter's story is drawn: each file mention, in reading order

  /** Starts a step's text: names resolve among these files, and no pill is drawn yet. */
  function startStep(scope) {
    linkScope = scope;
    pilled = new Set();
    lastRef = null;
  }
  const inScope = (rel) => linkScope.includes(rel);
  const noteMention = (rel) => {
    lastRef = rel;
  };

  /** {rel, line, bare} for a backticked name that's a file (or a line in one) of this step, else null. */
  function resolveRef(text) {
    const { name, line } = parseLineRef(unescapeHtml(text));
    if (!name && line) {
      let rel = null;
      if (lastRef && linkScope.includes(lastRef)) {
        rel = lastRef;
      } else if (linkScope.length === 1) {
        rel = linkScope[0];
      }
      return rel ? { rel, line, bare: true } : null;
    }
    if (!name || /\s/.test(name) || !/[./]/.test(name)) {
      return null;
    }
    const rel =
      linkScope.find((candidate) => candidate === name) ||
      linkScope.find((candidate) => candidate.endsWith('/' + name));
    if (rel) {
      lastRef = rel;
    }
    return rel ? { rel, line } : null;
  }

  /**
   * The status pill on a file's mention. While a chapter's story is drawn (pillMarks set), each mention leaves a
   * marker, and placePills() puts the pill on the file's LAST mention in reading order; earlier mentions get nothing.
   * Elsewhere (an answer), it goes on the first mention of a file the story didn't pill. A file this chapter finishes
   * gets the Mark viewed button; one a later chapter finishes gets nothing.
   */
  function pill(rel) {
    if (!state.n) {
      return '';
    }
    if (pillMarks) {
      return pillMarker(pillMarks.push(rel) - 1);
    }
    if (pilled.has(rel)) {
      return '';
    }
    pilled.add(rel);
    return pillHtml(rel);
  }
  function pillHtml(rel) {
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
  function storyWithPills(draw) {
    const marks = [];
    pillMarks = marks;
    let markup;
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

  return { startStep, inScope, noteMention, resolveRef, pill, storyWithPills };
}
