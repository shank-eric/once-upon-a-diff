/*
 * "Being changed": files a Claude session says it's changing (`once-upon working`, usually while it fixes notes
 * sent from Fix before push). A line at the top of the body names the session and the files, the step list and the
 * file list dim what it touches, and so does each file's block on the page. The marks come from opts.working(),
 * looked at when the pulse's working_rev moves. When the session is done they clear, and the usual "changed since"
 * marks show what changed.
 *
 * changingOf has no DOM, so node tests can use it.
 */
import { html } from '/assets/preact.mjs';
import { Banner } from '@once-upon-a-diff/ui-kit/components/banner';
import { shortDateTime } from '@once-upon-a-diff/terms/time';
import type { LineRanges, WorkingMark } from '@once-upon-a-diff/contracts/types';
import type { PanelContext } from '../host/context.ts';

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
  let marks: WorkingMark[] = [];

  const byRel = () => changingOf(marks, story.allRels);

  /** One line per session at work, over the step list. */
  function bannerView() {
    return marks.map((mark) => {
      const files = mark.files.slice(0, MAX_FILES_NAMED).map((file, index) => {
        const rel = relOf(file.path, story.allRels);
        return html`${index > 0 && ', '}<code data-rel=${rel} onClick=${context.refs.jumpClick(rel, null)}>${rel}</code>${rangesText(file.ranges || [])}`;
      });
      const more =
        mark.files.length > MAX_FILES_NAMED && ` and ${mark.files.length - MAX_FILES_NAMED} more`;
      return html`<${Banner} tone="warn" class="ou-beingchg" role="status">Being changed by <b>${mark.consumer}</b>: ${files}${more}<span class="ou-quiet"> · since ${shortDateTime(mark.started_at)}</span></${Banner}>`;
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

  /** The marks that touch step `step`'s files: who is changing the first of them, or null. */
  const stepWho = (step: number) => {
    const changing = byRel();
    const chapter = step ? context.steps()[step - 1] : null;
    return (chapter && chapter.files.map((file) => changing[file.rel]).find(Boolean)) || null;
  };

  /** A step's row in the step list: is a session changing a file of it, and the tag that says who. */
  const stepChanging = (step: number) => !!stepWho(step);
  function stepTag(step: number) {
    const who = stepWho(step);
    return who
      ? html`<span class="ou-chgby" title=${`Being changed by ${who.consumer}`}>• being changed</span>`
      : null;
  }

  /** A file's row in the file list: is a session changing it, and the tag that says who and which lines. */
  const fileChanging = (rel: string) => !!byRel()[rel];
  function fileTag(rel: string) {
    const who = byRel()[rel];
    return who
      ? html`<span class="ou-chgby">being changed by ${who.consumer}${rangesText(who.ranges)}</span>`
      : null;
  }

  /** The marks changed: the line, the rows' tags and the page. */
  function render() {
    shell.redraw();
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

  return {
    render,
    bannerView,
    refresh,
    dimPage,
    destroy,
    stepChanging,
    stepTag,
    fileChanging,
    fileTag,
  };
}

export type Working = ReturnType<typeof createWorking>;
