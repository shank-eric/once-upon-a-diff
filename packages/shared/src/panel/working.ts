/*
 * "Being changed": files a Claude session says it's changing (`once-upon working`, usually while it fixes notes
 * sent from Fix before push). A line at the top of the body names the session and the files, the step list and the
 * file list dim what it touches, and so does each file's block on the page. The marks come from opts.working(),
 * looked at when the pulse's working_rev moves. When the session is done they clear, and the usual "changed since"
 * marks show what changed.
 *
 * changingOf has no DOM, so node tests can use it.
 */
import { html } from '../util/html.ts';
import { insertHtml, setHtml } from '../util/dom.ts';
import { shortDateTime } from '../util/time.ts';
import type { LineRanges, WorkingMark } from '../types.ts';
import type { PanelContext } from './context.ts';

const MAX_FILES_NAMED = 6;

/** The story file a mark's path names: the path itself, or the one file it's a suffix of. */
function relOf(name: string, rels: string[]): string {
  if (rels.includes(name)) {
    return name;
  }
  const hits = rels.filter((rel) => rel.endsWith('/' + name));
  return hits.length === 1 ? hits[0] : name;
}

/** {<story file>: {consumer, ranges}} for the marks: who's changing each file, and which lines when it said. */
export function changingOf(
  marks: WorkingMark[] | null | undefined,
  rels: string[],
): Record<string, { consumer: string; ranges: LineRanges }> {
  const byRel: Record<string, { consumer: string; ranges: LineRanges }> = {};
  for (const mark of marks || []) {
    for (const file of mark.files || []) {
      byRel[relOf(file.path, rels)] = { consumer: mark.consumer, ranges: file.ranges || [] };
    }
  }
  return byRel;
}

const rangesText = (ranges: LineRanges) =>
  ranges.length
    ? ` (line${ranges.length > 1 || ranges[0][0] !== ranges[0][1] ? 's' : ''} ${ranges
        .map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`))
        .join(', ')})`
    : '';

export function createWorking(context: PanelContext) {
  const { story, opts, shell } = context;
  const { $ } = shell;
  let marks: WorkingMark[] = [];

  const byRel = () => changingOf(marks, story.allRels);

  /** One line per session at work, over the step list. */
  function bannerHtml() {
    return marks.map((mark) => {
      const files = mark.files.slice(0, MAX_FILES_NAMED).map((file, index) => {
        const rel = relOf(file.path, story.allRels);
        return html`${index > 0 && ', '}<code data-rel="${rel}">${rel}</code>${rangesText(file.ranges || [])}`;
      });
      const more =
        mark.files.length > MAX_FILES_NAMED && ` and ${mark.files.length - MAX_FILES_NAMED} more`;
      return html`<div class="ou-beingchg" role="status">Being changed by <b>${mark.consumer}</b>: ${files}${more}<span class="ou-quiet"> · since ${shortDateTime(mark.started_at)}</span></div>`;
    });
  }

  /** Dims the page's blocks of the files being changed (and undims the rest). */
  function dimPage() {
    const changing = byRel();
    for (const el of document.querySelectorAll('[data-ou-changing]')) {
      el.removeAttribute('data-ou-changing');
    }
    for (const [rel, who] of Object.entries(changing)) {
      const block = context.page.blockOf(rel);
      if (block) {
        block.el.setAttribute('data-ou-changing', who.consumer);
      }
    }
  }

  function render() {
    const box = $('.ou-working');
    if (box) {
      setHtml(box, bannerHtml());
    }
    const changing = byRel();
    for (const el of shell.root.querySelectorAll('.ou-chgby')) {
      el.remove();
    }
    for (const el of shell.root.querySelectorAll('.ou-changing')) {
      el.classList.remove('ou-changing');
    }
    const steps = context.steps();
    for (const item of shell.root.querySelectorAll('ol.ou-map li[data-n]')) {
      const step = Number(item.getAttribute('data-n'));
      const chapter = step ? steps[step - 1] : null;
      const who = chapter && chapter.files.map((file) => changing[file.rel]).find(Boolean);
      if (who) {
        item.classList.add('ou-changing');
        insertHtml(
          item,
          'beforeend',
          html`<span class="ou-chgby" title="Being changed by ${who.consumer}">• being changed</span>`,
        );
      }
    }
    for (const item of shell.root.querySelectorAll('ul.ou-files > li[data-file]')) {
      const who = changing[item.getAttribute('data-file') as string];
      if (who) {
        item.classList.add('ou-changing');
        insertHtml(
          item.querySelector('code') as Element,
          'afterend',
          html`<span class="ou-chgby">being changed by ${who.consumer}${rangesText(who.ranges)}</span>`,
        );
      }
    }
    dimPage();
  }

  async function refresh() {
    if (!opts.working) {
      return;
    }
    try {
      const next = ((await opts.working()) || {}).marks || [];
      if (JSON.stringify(next) !== JSON.stringify(marks)) {
        marks = next;
        render();
      }
    } catch {
      /* the bridge may be down; the next pulse looks again */
    }
  }

  function destroy() {
    marks = [];
    dimPage();
  }

  refresh();

  return { render, refresh, dimPage, destroy };
}

export type Working = ReturnType<typeof createWorking>;
