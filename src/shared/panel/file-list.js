/*
 * The file list: "Files in this chapter" (or the Overview's "All files"),
 * each file with its status in this chapter (Mark viewed, done in an earlier
 * chapter, or nothing when a later chapter finishes it) and its line links.
 */
import { html } from '../util/html.js';
import { refAttrs } from './file-refs.js';
import { markViewedButton } from './viewed.js';

/** "chapters 1, 3": which chapters list a file. */
const chaptersLabel = (prefix, steps, list) =>
  `${prefix}${steps.length > 1 ? 's' : ''} ${list(steps)}`;

export function createFileList(context) {
  const { story, state } = context;
  const { data } = story;

  /** The line under the file's name: where it's finished, or what this chapter covers of it. */
  function whyText(file, step, status) {
    if (step === 0) {
      return chaptersLabel('chapter', story.chaptersOf(file.rel), story.chapterList);
    }
    if (status && status.kind === 'later') {
      return file.partial && file.note ? `here: ${file.note}` : ''; // a later chapter finishes it: no tag here
    }
    return `${status ? status.text : ''}${file.partial && status && file.note ? ` (here: ${file.note})` : ''}`;
  }

  function lineItems(file) {
    return (file.lines || []).map((line) => {
      const side = line.side === 'L' ? 'L' : 'R';
      const span =
        line.end && line.end !== line.start ? `s ${line.start}–${line.end}` : ` ${line.start}`;
      const range = `${side === 'L' ? 'old ' : ''}line${span}`;
      const attrs = refAttrs(file.rel, { side, start: line.start, end: line.end || line.start });
      return html`<li><span ${attrs}>${range}</span>${line.label && ` ${line.label}`}</li>`;
    });
  }

  /** One file's row in step `step`'s list. */
  function fileItem(file, step) {
    const status = context.fileStatus(file.rel, step);
    const why = whyText(file, step, status);
    // a file this chapter finishes: a Mark viewed button, which the viewed tracker turns into "Viewed ✓" while its Viewed toggle is on
    const mark = step && status && status.kind === 'mark';
    const whyHtml = mark
      ? html`${markViewedButton(file.rel)}${why.slice(status.text.length)}`
      : why;
    const whyKind = status && status.kind !== 'later' ? ` ou-st-${status.kind}` : '';
    const lines = lineItems(file);
    const whyLine = why && html`<span class="ou-why${whyKind}">${whyHtml}</span>`;
    const lineList = lines.length > 0 && html`<ul class="ou-lines">${lines}</ul>`;
    return html`<li data-file="${file.rel}"><code ${refAttrs(file.rel, null)}>${file.rel}</code><span class="ou-viewed" data-viewed-for="${file.rel}"></span>${whyLine}${lineList}</li>`;
  }

  /** "4 to mark viewed · 2 come back later · 1 already finished" for chapter `step`. */
  function filesSummary(step) {
    const kinds = { mark: 0, later: 0, done: 0 };
    for (const file of data.chapters[step - 1].files) {
      const status = context.fileStatus(file.rel, step);
      if (status) {
        kinds[status.kind]++;
      }
    }
    return [
      kinds.mark && `${kinds.mark} to mark viewed`,
      kinds.later && `${kinds.later} come${kinds.later === 1 ? 's' : ''} back later`,
      kinds.done && `${kinds.done} already finished`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** The folded list under its heading; it remembers whether it was open (state.filesOpen). */
  function filesBox(title, summary, items) {
    const summaryHtml = summary && html`<span class="ou-sum">${summary}</span>`;
    return html`<details class="ou-filesbox"${state.filesOpen && html` open`}><summary><h2 class="ou-h">${title}</h2>${summaryHtml}</summary><ul class="ou-files">${items}</ul></details>`;
  }

  return { fileItem, filesSummary, filesBox };
}
