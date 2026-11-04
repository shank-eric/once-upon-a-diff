/*
 * The file list: "Files in this chapter" (or the Overview's "All files"),
 * each file with its status in this chapter (Mark viewed, done in an earlier
 * chapter, or nothing when a later chapter finishes it) and its line links.
 * The rows are drawn from the viewed tracker's snapshot, the change tags and the working marks, so they stay current as those do.
 */
import { html } from '/assets/preact.mjs';
import type { VNode } from '@once-upon-a-diff/ui/parse-markup';
import type { ChapterLines } from '@once-upon-a-diff/protocol/types';
import type { FileStatus } from '../story-model.ts';
import type { PanelContext } from '../context.ts';

/** A row's file: a chapter's entry, or one of the story's files on the Overview. */
type FileEntry = { rel: string; partial?: boolean; note?: string | null; lines?: ChapterLines[] };

const chaptersLabel = (prefix: string, steps: number[], list: (steps: number[]) => string) =>
  `${prefix}${steps.length > 1 ? 's' : ''} ${list(steps)}`;

export function createFileList(context: PanelContext) {
  const { story, state } = context;
  const { data } = story;

  /** The line under the file's name: where it's finished, or what this chapter covers of it. */
  function whyText(file: FileEntry, step: number, status: FileStatus | null): string {
    if (step === 0) {
      return chaptersLabel('chapter', story.chaptersOf(file.rel), story.chapterList);
    }
    if (status && status.kind === 'later') {
      return file.partial && file.note ? `here: ${file.note}` : ''; // a later chapter finishes it: no tag here
    }
    return `${status ? status.text : ''}${file.partial && status && file.note ? ` (here: ${file.note})` : ''}`;
  }

  function lineItems(file: FileEntry) {
    return (file.lines || []).map((line) => {
      const side = line.side === 'L' ? 'L' : 'R';
      const span =
        line.end && line.end !== line.start ? `s ${line.start}–${line.end}` : ` ${line.start}`;
      const range = `${side === 'L' ? 'old ' : ''}line${span}`;
      const link = context.refs.jumpProps(file.rel, {
        side,
        start: line.start,
        end: line.end || line.start,
      });
      return html`<li><span ...${link}>${range}</span>${line.label ? ` ${line.label}` : null}</li>`;
    });
  }

  /** One file's row in step `step`'s list. */
  function fileItem(file: FileEntry, step: number): VNode {
    const status = context.fileStatus(file.rel, step);
    const why = whyText(file, step, status);
    // a file this chapter finishes: a Mark viewed button, which the viewed tracker keeps in step with its Viewed toggle
    const mark = !!(step && status && status.kind === 'mark');
    const whyContent = mark
      ? html`${context.viewed.markButton(file.rel, false)}${why.slice((status as FileStatus).text.length)}`
      : why;
    const whyKind = status && status.kind !== 'later' ? ` ou-st-${status.kind}` : '';
    const lines = lineItems(file);
    const viewed = context.viewed.fileMark(file.rel, mark);
    const classes = [
      context.filter.seen.missing.includes(file.rel) && 'ou-missing',
      context.working.fileChanging(file.rel) && 'ou-changing',
    ]
      .filter(Boolean)
      .join(' ');
    return html`<li data-file=${file.rel} class=${classes || undefined}><code ...${context.refs.jumpProps(file.rel, null)}>${file.rel}</code>${context.working.fileTag(file.rel)}${context.marks.fileTags(file.rel)}<span class=${viewed?.early ? 'ou-viewed ou-early' : 'ou-viewed'} data-viewed-for=${file.rel} title=${viewed ? viewed.title : undefined}>${viewed?.text || null}</span>${why ? html`<span class=${`ou-why${whyKind}`}>${whyContent}</span>` : null}${lines.length > 0 ? html`<ul class="ou-lines">${lines}</ul>` : null}</li>`;
  }

  /** "4 to mark viewed · 2 come back later · 1 already finished" for chapter `step`. */
  function filesSummary(step: number): string {
    const kinds = { mark: 0, later: 0, done: 0, pending: 0 };
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
      kinds.pending && `${kinds.pending} waiting for the story`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** The folded list under its heading; it remembers whether it was open (state.filesOpen). */
  function filesBox(title: string, summary: string, items: VNode[]): VNode {
    const onToggle = (event: Event) => {
      const open = (event.currentTarget as HTMLDetailsElement).open;
      if (state.filesOpen !== open) {
        state.filesOpen = open;
        context.saveState();
      }
    };
    return html`<details class="ou-filesbox" open=${state.filesOpen} onToggle=${onToggle}><summary><h2 class="ou-h">${title}</h2>${summary ? html`<span class="ou-sum">${summary}</span>` : null}</summary><ul class="ou-files">${items}</ul></details>`;
  }

  return { fileItem, filesSummary, filesBox };
}

export type FileList = ReturnType<typeof createFileList>;
