/*
 * Viewed progress: which of a chapter's "Mark viewed" files are ticked, read
 * from the page's own Viewed toggle (GitHub's, or the local page's), and the
 * Mark viewed button. Files that come back in a later chapter, or were
 * finished in an earlier one, don't count.
 *
 * The panel clicks a Viewed toggle in one place only (toggle below): the
 * reviewer clicked that file's Mark viewed button, or its "Viewed ✓" to
 * untick it. One click, one file: nothing ticks Viewed on its own, on a step
 * change, in bulk or for any other file.
 */
import { escapeHtml } from '../util/html.js';
import { baseName, capitalize } from '../util/text.js';
import { readStepsOf } from './reading.js';

/** The Mark viewed button for a file this chapter finishes. The tracker keeps its label in step with the file's Viewed toggle. */
export function markViewedButton(rel, short) {
  const label = short ? 'mark viewed' : 'Mark viewed';
  return `<button type="button" class="prs-mark prs-st-mark" data-mark-for="${escapeHtml(rel)}"${short ? ' data-mark-short="1"' : ''} title="Tick ${escapeHtml(rel)}'s Viewed checkbox">${label}</button>`;
}

const linkList = (rels) =>
  rels
    .map(
      (rel) =>
        `<code data-rel="${escapeHtml(rel)}" title="Scroll to ${escapeHtml(rel)}">${escapeHtml(baseName(rel))}</code>`,
    )
    .join(', ');

export function createViewedTracker(context) {
  const { story, state, page, shell } = context;
  const { data } = story;
  const { $ } = shell;

  /** How chapter `step`'s files to mark viewed stand: {due, viewed, unviewed, unknown, noToggle}. */
  function progressOf(step, blocks) {
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

  function renderFileMarks(blocks, earlyFor) {
    for (const el of shell.root.querySelectorAll('[data-viewed-for]')) {
      const rel = el.getAttribute('data-viewed-for');
      const viewed = page.isViewed(rel, blocks);
      const early = viewed === true && earlyFor(rel);
      // its "Viewed ✓" button says it
      const tagged =
        !!el.parentElement &&
        !!el.parentElement.querySelector(':scope > .prs-why > [data-mark-for]');
      let text = '';
      if (viewed === true && early) {
        text = '⚠ viewed early';
      } else if (viewed === true && !tagged) {
        text = '✓ viewed';
      }
      el.textContent = text;
      el.classList.toggle('prs-early', early);
      el.title = early
        ? `Marked viewed, but ${story.chapterName(story.finishedIn[rel])} covers more of it. You may want to unmark it until then.`
        : '';
    }
    // the button on a file this chapter finishes: "Mark viewed" until its Viewed toggle is on, then "Viewed ✓" (a click unticks it)
    for (const el of shell.root.querySelectorAll('[data-mark-for]')) {
      const rel = el.getAttribute('data-mark-for');
      const isOn = page.isViewed(rel, blocks) === true;
      if (el.hasAttribute('data-mark-short')) {
        el.textContent = isOn ? 'viewed ✓' : 'mark viewed';
      } else {
        el.textContent = isOn ? 'Viewed ✓' : 'Mark viewed';
      }
      el.classList.toggle('prs-st-viewed', isOn);
      el.classList.toggle('prs-st-mark', !isOn);
      el.setAttribute('aria-pressed', String(isOn));
      el.title = isOn
        ? `Viewed. Click to untick ${rel}'s Viewed checkbox`
        : `Tick ${rel}'s Viewed checkbox`;
    }
  }

  function renderEarlyBox(blocks, step, earlyFor) {
    const earlyBox = $('.prs-early-box');
    if (!earlyBox) {
      return;
    }
    const inChapter = step ? new Set(context.chapter().files.map((file) => file.rel)) : new Set();
    const early = step
      ? story.allRels.filter((rel) => earlyFor(rel) && page.isViewed(rel, blocks) === true)
      : [];
    earlyBox.innerHTML = early
      .map((rel) => {
        const owner = story.chapterName(story.finishedIn[rel]);
        if (inChapter.has(rel)) {
          return `<p>⚠ <code data-rel="${escapeHtml(rel)}">${escapeHtml(baseName(rel))}</code> is marked viewed, but ${owner} covers more of it. You may want to unmark it until then.</p>`;
        }
        return `<p>⚠ <code>${escapeHtml(baseName(rel))}</code> is marked viewed early: it belongs to ${owner}. You may want to unmark it until then.</p>`;
      })
      .join('');
  }

  function renderStepProgress(all) {
    for (const el of shell.root.querySelectorAll('[data-prog-for]')) {
      const progress = all[Number(el.getAttribute('data-prog-for')) - 1];
      if (!progress || !progress.due || progress.noToggle) {
        el.textContent = '';
        continue;
      }
      const complete = progress.viewed === progress.due;
      el.textContent = complete ? '✓' : `${progress.viewed}/${progress.due}`;
      el.classList.toggle('prs-done', complete);
      el.title = complete
        ? 'Every file to mark viewed here is ticked'
        : `${progress.viewed} of ${progress.due} marked viewed`;
    }
  }

  function renderOverviewProgress(box, all) {
    const due = all.reduce((sum, progress) => sum + progress.due, 0);
    const viewed = all.reduce((sum, progress) => sum + progress.viewed, 0);
    const left = all
      .map((progress, index) => ({ progress, index }))
      .filter(({ progress }) => progress.viewed < progress.due)
      .map(({ index }) => index + 1);
    box.classList.toggle('prs-complete', !!due && viewed === due);
    if (!due) {
      box.innerHTML = '';
    } else if (viewed === due) {
      box.innerHTML = `<span class="prs-done">✓ All ${due} files marked viewed</span>`;
    } else {
      const still = left.length
        ? ` · ${left.map(story.chapterName).join(', ')} still ${left.length > 1 ? 'have' : 'has'} some to go`
        : '';
      box.innerHTML = `<b>${viewed} of ${due}</b> files marked viewed${still}`;
    }
  }

  /** Redraws every viewed mark in the panel from the page's Viewed toggles. */
  function render() {
    const blocks = page.blocksByPath();
    // viewed too early: a file whose last chapter is still to come (it comes back later, or it's only a later chapter's), never one already finished,
    // and never one whose last chapter they've already read (a review done earlier, or before read tracking)
    const step = context.inBackstory() ? 0 : state.n;
    const readSteps = readStepsOf(data.chapters, context.reading.info);
    const earlyFor = (rel) =>
      step > 0 &&
      story.finishedIn[rel] != null &&
      story.finishedIn[rel] > step &&
      !readSteps.has(story.finishedIn[rel]);
    renderFileMarks(blocks, earlyFor);
    renderEarlyBox(blocks, step, earlyFor);
    const box = $('.prs-progress');
    if (!box) {
      return;
    }
    box.classList.remove('prs-complete');
    if (context.inBackstory()) {
      box.innerHTML = '';
      return;
    }
    const all = data.chapters.map((chapter, index) => progressOf(index + 1, blocks));
    if (
      all.some((progress) => progress.noToggle) &&
      !all.some((progress) => progress.viewed || progress.unviewed.length)
    ) {
      box.innerHTML = ''; // no Viewed toggles on this page to read
      return;
    }
    context.reading.noteProgress(all);
    renderStepProgress(all);
    if (state.n === 0) {
      renderOverviewProgress(box, all);
      return;
    }
    const progress = all[state.n - 1];
    // ticking the last of a chapter's files counts as reading it (only a change seen here, not a chapter already complete on load)
    context.reading.noteComplete(
      state.n,
      !!(progress && progress.due && progress.viewed === progress.due),
    );
    if (!progress || !progress.due) {
      box.innerHTML = '<span>Nothing to mark viewed in this chapter</span>';
      return;
    }
    if (progress.viewed === progress.due) {
      box.classList.add('prs-complete');
      box.innerHTML = `<span class="prs-done">✓ All ${progress.due} marked viewed</span>`;
      return;
    }
    box.innerHTML =
      `<b>${progress.viewed} of ${progress.due}</b> marked viewed` +
      (progress.unviewed.length ? ` · still to mark: ${linkList(progress.unviewed)}` : '') +
      (progress.unknown.length ? ` · ${progress.unknown.length} not loaded yet` : '');
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
  function toggle(rel) {
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
  function leftToMark(step) {
    return progressOf(step, page.blocksByPath()).unviewed;
  }
  const leavingMessage = (step, left) =>
    `${capitalize(story.chapterName(step))} still has ${left.length} to mark viewed: ${left.map(baseName).join(', ')}. No rush: Prev goes back, or tick them later.`;

  function destroy() {
    document.removeEventListener('change', recheck, true);
    document.removeEventListener('click', recheck, true);
  }

  return { render, toggle, progressOf, leftToMark, leavingMessage, destroy };
}
