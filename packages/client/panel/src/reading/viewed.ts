/*
 * Viewed progress: which of a chapter's "Mark viewed" files are ticked, read
 * from the page's own Viewed toggle (GitHub's, or the local page's), and the
 * Mark viewed button. Files that come back in a later chapter, or were
 * finished in an earlier one, don't count.
 *
 * The tracker reads the toggles into a snapshot (compute) and the panel draws from it: a file's "✓ viewed" or "⚠ viewed early",
 * the Mark viewed buttons, the step list's progress, and the progress and early boxes under the story's first heading.
 *
 * The panel clicks a Viewed toggle in one place only (toggle below): the
 * reviewer clicked that file's Mark viewed button, or its "Viewed ✓" to
 * untick it. One click, one file: nothing ticks Viewed on its own, on a step
 * change, in bulk or for any other file.
 */
import { html } from '/assets/preact.mjs';
import { baseName, capitalize, plural } from '@once-upon-a-diff/terms/text';
import { markViewedNode } from '../components/mark-viewed-node.ts';
import { viewedEarlyCheck } from './read-checks.ts';
import type { VNode } from '@once-upon-a-diff/ui-kit/parse-markup';
import type { PanelContext } from '../host/context.ts';
import type { StepProgress } from './read-checks.ts';
import type { FileBlock } from '../host/host.ts';

type Toggle = boolean | 'none' | null;

/** What the page's Viewed toggles said at the last look, for the step on screen. */
interface Snapshot {
  step: number;
  /** each file of the step: its toggle */
  states: Map<string, Toggle>;
  /** the files of the step that are early: finished in a later chapter, or read in their last chapter already */
  early: Set<string>;
  /** every story file that is viewed early: the early box lists them on a chapter */
  earlyList: string[];
  /** each chapter's progress, null when the page has no Viewed toggles to read */
  progress: StepProgress[] | null;
  /** what the step list shows: the progress, or the last there was while the page has no toggles, until the body is drawn again */
  rows: StepProgress[] | null;
}

/** What the progress box says, and whether it is the complete one. */
interface ProgressLine {
  complete: boolean;
  content: unknown;
}

export function createViewedTracker(context: PanelContext) {
  const { story, state, page, shell } = context;
  const { data } = story;

  /** A file name as a jump link. */
  const jump = (rel: string) =>
    html`<code data-rel=${rel} role="link" tabindex="0" title=${`Scroll to ${rel}`} onClick=${context.refs.jumpClick(rel, null)}>${baseName(rel)}</code>`;
  const linkList = (rels: string[]) =>
    rels.map((rel, index) => html`${index > 0 && ', '}${jump(rel)}`);

  let snapshot: Snapshot | null = null;
  let lastKey = '';

  /** How chapter `step`'s files to mark viewed stand: {due, viewed, unviewed, unknown, noToggle}. */
  function progressOf(step: number, blocks: Map<string, FileBlock>): StepProgress {
    const due = data.chapters[step - 1].files
      .filter((file) => {
        const status = context.fileStatus(file.rel, step);
        return status && status.kind === 'mark';
      })
      .map((file) => file.rel);
    const marks = due.map((rel) => ({ rel, viewed: page.isViewed(rel, blocks) }));
    return {
      due: due.length,
      viewed: marks.filter((mark) => mark.viewed === true).length,
      unviewed: marks.filter((mark) => mark.viewed === false).map((mark) => mark.rel),
      unknown: marks.filter((mark) => mark.viewed == null).map((mark) => mark.rel),
      noToggle:
        marks.length > 0 &&
        marks.every((mark) => mark.viewed === 'none' || mark.viewed == null) &&
        marks.some((mark) => mark.viewed === 'none'),
    };
  }

  // ---------- what is drawn, from the snapshot

  /** A file's mark in the file list: its text, whether it is early, and the hover. Null before the first look. */
  function fileMark(rel: string, tagged: boolean) {
    if (!snapshot) {
      return null;
    }
    const viewed = snapshot.states.get(rel) ?? null;
    const early = viewed === true && snapshot.early.has(rel);
    let text = '';
    if (viewed === true && early) {
      text = '⚠ viewed early';
    } else if (viewed === true && !tagged) {
      text = '✓ viewed'; // a file with a "Viewed ✓" button says it there
    }
    const title = early
      ? `Marked viewed, but ${story.chapterName(story.finishedIn[rel])} covers more of it. You may want to unmark it until then.`
      : '';
    return { text, early, title };
  }

  /** The Mark viewed button for a file, as a node. */
  const markButton = (rel: string, short: boolean): VNode =>
    markViewedNode(rel, short, snapshot ? snapshot.states.get(rel) === true : null, () => {
      context.count('panel.viewed.mark');
      toggle(rel);
    });

  /** A chapter's progress on the step list: its text, whether it is complete, the hover. Null when it has none to show. */
  function stepProgress(step: number) {
    const progress = snapshot?.rows?.[step - 1];
    if (!progress || !progress.due || progress.noToggle) {
      return null;
    }
    const complete = progress.viewed === progress.due;
    return {
      text: complete ? '✓' : `${progress.viewed}/${progress.due}`,
      done: complete,
      title: complete
        ? 'Every file to mark viewed here is ticked'
        : `${progress.viewed} of ${progress.due} marked viewed`,
    };
  }

  function overviewProgress(all: StepProgress[]): ProgressLine {
    const writing = data.chapters.filter((chapter) => chapter.unwritten).length;
    const due = all.reduce((sum, progress) => sum + progress.due, 0);
    const viewed = all.reduce((sum, progress) => sum + progress.viewed, 0);
    const left = all
      .map((progress, index) => ({ progress, index }))
      .filter(({ progress }) => progress.viewed < progress.due)
      .map(({ index }) => index + 1);
    const complete = !!due && viewed === due && !writing;
    const stillWriting = writing ? ` · ${plural(writing, 'chapter')} still being written` : '';
    if (!due) {
      return { complete, content: writing ? html`<span>${stillWriting.slice(3)}</span>` : null };
    }
    if (viewed === due && writing) {
      return {
        complete,
        content: html`<b>${viewed} of ${due}</b> files marked viewed${stillWriting}`,
      };
    }
    if (viewed === due) {
      return {
        complete,
        content: html`<span class="ou-done">✓ All ${due} files marked viewed</span>`,
      };
    }
    const still = left.length
      ? ` · ${left.map(story.chapterName).join(', ')} still ${left.length > 1 ? 'have' : 'has'} some to go`
      : '';
    return {
      complete,
      content: html`<b>${viewed} of ${due}</b> files marked viewed${still}${stillWriting}`,
    };
  }

  function chapterProgress(progress: StepProgress | undefined): ProgressLine {
    if (!progress || !progress.due) {
      const waiting = context.chapter()?.unwritten;
      return {
        complete: false,
        content: waiting
          ? html`<span>Mark viewed unlocks when this chapter's story is written</span>`
          : html`<span>Nothing to mark viewed in this chapter</span>`,
      };
    }
    if (progress.viewed === progress.due) {
      return {
        complete: true,
        content: html`<span class="ou-done">✓ All ${progress.due} marked viewed</span>`,
      };
    }
    const toMark =
      progress.unviewed.length > 0 && html` · still to mark: ${linkList(progress.unviewed)}`;
    const notLoaded = progress.unknown.length > 0 && ` · ${progress.unknown.length} not loaded yet`;
    return {
      complete: false,
      content: html`<b>${progress.viewed} of ${progress.due}</b> marked viewed${toMark}${notLoaded}`,
    };
  }

  /** The progress box and the early box that sit under the story's first heading. */
  function boxes(): VNode[] {
    const snap = snapshot;
    let progress: ProgressLine = { complete: false, content: null };
    if (snap?.progress) {
      progress =
        snap.step === 0
          ? overviewProgress(snap.progress)
          : chapterProgress(snap.progress[snap.step - 1]);
    }
    const early = snap && snap.step ? snap.earlyList : [];
    const inChapter = snap && snap.step ? context.inChapter() : new Set<string>();
    const lines = early.map((rel) => {
      const owner = story.chapterName(story.finishedIn[rel]);
      if (inChapter.has(rel)) {
        return html`<p>⚠ ${jump(rel)} is marked viewed, but ${owner} covers more of it. You may want to unmark it until then.</p>`;
      }
      return html`<p>⚠ <code>${baseName(rel)}</code> is marked viewed early: it belongs to ${owner}. You may want to unmark it until then.</p>`;
    });
    return [
      html`<div class=${progress.complete ? 'ou-progress ou-complete' : 'ou-progress'} aria-live="polite">${progress.content}</div>`,
      html`<div class="ou-early-box" role="status">${lines}</div>`,
    ];
  }

  // ---------- reading the page

  /**
   * Reads the page's Viewed toggles into the snapshot, and tells the reading part what they say. True when what the panel draws
   * changed. It draws nothing itself: render() does that, and a step change, which draws anyway, calls this first with `fresh`: the
   * body is drawn again, so the step list starts blank until there are toggles to read.
   */
  function compute(fresh = false): boolean {
    const blocks = page.blocksByPath();
    // viewed too early: a file whose last chapter is still to come (it comes back later, or it's only a later chapter's), never one already finished,
    // one they've read in its last chapter (a review done earlier, or before read tracking), or any on a "Since you read it" step
    const step = state.n;
    const earlyFor = viewedEarlyCheck({
      chapters: data.chapters,
      finishedIn: story.finishedIn,
      readInfo: context.reading.info,
      step,
    });
    const states = new Map<string, Toggle>(
      [...context.inChapter()].map((rel) => [rel, page.isViewed(rel, blocks)]),
    );
    const early = new Set([...states.keys()].filter((rel) => earlyFor(rel)));
    const earlyList = step
      ? story.allRels.filter((rel) => earlyFor(rel) && page.isViewed(rel, blocks) === true)
      : [];
    let progress: StepProgress[] | null = null;
    if (context.body.ready()) {
      const all = data.chapters.map((chapter, index) => progressOf(index + 1, blocks));
      const noToggles =
        all.some((each) => each.noToggle) &&
        !all.some((each) => each.viewed || each.unviewed.length);
      if (!noToggles) {
        progress = all;
        context.reading.noteProgress(all);
        if (step > 0) {
          const mine = all[step - 1];
          // ticking the last of a chapter's files counts as reading it (only a change seen here, not a chapter already complete on load)
          context.reading.noteComplete(step, !!(mine && mine.due && mine.viewed === mine.due));
        }
      }
    }
    const rows = progress ?? (fresh ? null : (snapshot?.rows ?? null));
    snapshot = { step, states, early, earlyList, progress, rows };
    const key = JSON.stringify([step, [...states], [...early], earlyList, progress, rows]);
    const changed = key !== lastKey;
    lastKey = key;
    return changed;
  }

  /** Redraws the viewed marks from the page's Viewed toggles. */
  function render() {
    if (compute()) {
      shell.redraw();
    }
  }

  // Classic /files ticks a checkbox (no attribute change), and Refined GitHub's batch
  // helpers click many toggles at once, so also look again shortly after any click or change.
  const recheck = () => {
    setTimeout(render, 300);
    setTimeout(render, 1200);
  };
  document.addEventListener('change', recheck, true);
  document.addEventListener('click', recheck, true);

  /**
   * The one place the panel clicks a Viewed toggle: the reviewer clicked this file's Mark viewed button (or its
   * "Viewed ✓", to untick it). It clicks that file's own toggle once, as if the reviewer had, and GitHub (or the
   * local page) does the rest, collapse included. Nothing else calls it: no step change, redraw or batch.
   */
  function toggle(rel: string) {
    const block = page.blockOf(rel);
    const viewedToggle = block && page.viewedToggleIn(block.el);
    if (!viewedToggle) {
      shell.message(
        block
          ? `${baseName(rel)} has no Viewed checkbox on this page.`
          : `${baseName(rel)} isn't loaded on the page yet. Scrolling to it: click Mark viewed again once it shows.`,
      );
      if (!block) {
        context.scroll.jumpTo(rel);
      }
      return;
    }
    if (viewedToggle.disabled) {
      shell.message(
        `${context.hostName} isn't letting ${baseName(rel)} be marked viewed right now.`,
      );
      return;
    }
    viewedToggle.click();
    recheck();
  }

  /** The step's files left to mark viewed, said when they move on from it. */
  function leftToMark(step: number): string[] {
    return progressOf(step, page.blocksByPath()).unviewed;
  }
  const leavingMessage = (step: number, left: string[]) =>
    `${capitalize(story.chapterName(step))} still has ${left.length} to mark viewed: ${left.map(baseName).join(', ')}. No rush: Prev goes back, or tick them later.`;

  function destroy() {
    document.removeEventListener('change', recheck, true);
    document.removeEventListener('click', recheck, true);
  }

  return {
    compute,
    render,
    toggle,
    progressOf,
    leftToMark,
    leavingMessage,
    fileMark,
    markButton,
    stepProgress,
    boxes,
    destroy,
  };
}

export type ViewedTracker = ReturnType<typeof createViewedTracker>;
