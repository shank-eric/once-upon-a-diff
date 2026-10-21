/*
 * The file list: "Files in this chapter" (or the Overview's "All files"),
 * each file with its status in this chapter (Mark viewed, done in an earlier
 * chapter, or nothing when a later chapter finishes it), its line links, and
 * a "why" link that opens its "How it got here".
 */
import { escapeHtml } from '../util/html.js';
import { refAttrs } from './file-refs.js';
import { markViewedButton } from './viewed.js';

/** "story chapters 1, 3": which chapters list a file. */
const chaptersLabel = (prefix, steps, list) =>
  `${prefix}${steps.length > 1 ? 's' : ''} ${list(steps)}`;

export function createFileList(context) {
  const { story, state } = context;
  const { data } = story;

  /** The line under the file's name: where it's finished, or what this chapter covers of it. */
  function whyText(file, step, status) {
    const steps = story.chaptersOf(file.rel);
    if (context.inBackstory()) {
      return steps.length ? chaptersLabel('story chapter', steps, story.chapterList) : '';
    }
    if (step === 0) {
      return chaptersLabel('chapter', steps, story.chapterList);
    }
    if (status && status.kind === 'later') {
      return file.partial && file.note ? `here: ${file.note}` : ''; // a later chapter finishes it: no tag here
    }
    return `${status ? status.text : ''}${file.partial && status && file.note ? ` (here: ${file.note})` : ''}`;
  }

  function lineItems(file) {
    return (file.lines || [])
      .map((line) => {
        const side = line.side === 'L' ? 'L' : 'R';
        const span =
          line.end && line.end !== line.start ? `s ${line.start}–${line.end}` : ` ${line.start}`;
        const range = `${side === 'L' ? 'old ' : ''}line${span}`;
        const attrs = refAttrs(file.rel, { side, start: line.start, end: line.end || line.start });
        return `<li><span ${attrs}>${range}</span>${line.label ? ` ${escapeHtml(line.label)}` : ''}</li>`;
      })
      .join('');
  }

  /** One file's row in step `step`'s list. */
  function fileItem(file, step) {
    const status = context.fileStatus(file.rel, step);
    const why = whyText(file, step, status);
    // a file this chapter finishes: a Mark viewed button, which the viewed tracker turns into "Viewed ✓" while its Viewed toggle is on
    const mark = !context.inBackstory() && step && status && status.kind === 'mark';
    const whyHtml = mark
      ? `${markViewedButton(file.rel)}${escapeHtml(why.slice(status.text.length))}`
      : escapeHtml(why);
    const whyKind = status && status.kind !== 'later' ? ` prs-st-${status.kind}` : '';
    // "why": the file's How it got here, collapsed under the row
    const storyEntry =
      !context.inBackstory() && step
        ? data.chapters[step - 1].files.find((entry) => entry.rel === file.rel) || file
        : file;
    const how = context.inBackstory() ? '' : context.backstory.fileBackstory(storyEntry);
    const whyLink = how
      ? ` <button class="prs-linkish prs-whylink" aria-expanded="false" title="How it got here">why</button>`
      : '';
    const whyBox = how ? `<div class="prs-whybox" hidden>${how}</div>` : '';
    const lines = lineItems(file);
    return (
      `<li data-file="${escapeHtml(file.rel)}"><code ${refAttrs(file.rel, null)}>${escapeHtml(file.rel)}</code><span class="prs-viewed" data-viewed-for="${escapeHtml(file.rel)}"></span>${whyLink}` +
      `${why ? `<span class="prs-why${whyKind}">${whyHtml}</span>` : ''}${lines ? `<ul class="prs-lines">${lines}</ul>` : ''}${whyBox}</li>`
    );
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
    const summaryHtml = summary ? `<span class="prs-sum">${escapeHtml(summary)}</span>` : '';
    return (
      `<details class="prs-filesbox"${state.filesOpen ? ' open' : ''}>` +
      `<summary><h2 class="prs-h">${escapeHtml(title)}</h2>${summaryHtml}</summary>` +
      `<ul class="prs-files">${items}</ul></details>`
    );
  }

  return { fileItem, filesSummary, filesBox };
}
