/*
 * A chapter's own lines: what other chapters tell in a shared file folds
 * away (narrow.js), and a jump from the panel opens the file and the folds
 * that hold its lines. Viewed stays as it is.
 */
import { chapterNumbers } from '/assets/overlay.js';
import { claimsOf, narrowRows } from '/assets/narrow.js';
import { escapeHtml } from '/assets/util/html.js';
import { page } from './page.js';
import { columnCount } from './diff-view.js';

let narrowedFor = null; // the step the tables are narrowed for; a redraw clears it
/** A redraw draws new tables, so the next filter pass narrows them again. */
export const forgetNarrowing = () => {
  narrowedFor = null;
};

/** One table row, as narrowRows reads it. */
function rowModel(row) {
  if (row.classList.contains('ds-hunk')) {
    return { type: 'hunk' };
  }
  if (row.classList.contains('ds-note-row') || row.classList.contains('ds-note-edit')) {
    return { type: 'note' };
  }
  if (!row.classList.contains('ds-line')) {
    return { type: 'info' };
  }
  const lineOn = (side) => {
    const cell = row.querySelector(`td[data-side="${side}"]`);
    return cell ? Number(cell.getAttribute('data-line')) : null;
  };
  return {
    type: 'line',
    L: lineOn('L'),
    R: lineOn('R'),
    add: row.classList.contains('ds-add') || !!row.querySelector('td.ds-n-add'),
  };
}

function stepName(step) {
  const numbers = chapterNumbers(page.story.chapters);
  if (numbers[step - 1] != null) {
    return `chapter ${numbers[step - 1]}`;
  }
  return `“${String(page.story.chapters[step - 1].title || 'Since you read it').replace(/:.*$/, '')}”`;
}

export function unnarrow(root = document) {
  for (const el of root.querySelectorAll('tr.ds-narrow')) {
    el.remove();
  }
  for (const el of root.querySelectorAll('tr.ds-out')) {
    el.classList.remove('ds-out');
  }
}

/** Called by the panel after each filter pass. Only a new step (or a redraw) changes the tables, so the folds the reviewer opens stay open. */
export function narrow({ n: step, all }) {
  const key = `${step}|${all}`;
  if (key === narrowedFor) {
    return;
  }
  narrowedFor = key;
  unnarrow();
  if (all || !step) {
    return;
  }
  const claims = claimsOf(page.story.chapters);
  for (const section of document.querySelectorAll('.ds-file')) {
    const rel = section.getAttribute('data-path');
    const rows = [...section.querySelectorAll('tbody > tr')];
    const { hidden, runs } = narrowRows(rows.map(rowModel), claims, rel, step);
    rows.forEach((row, i) => row.classList.toggle('ds-out', hidden[i]));
    for (const run of runs) {
      const lines = rows
        .slice(run.from, run.to + 1)
        .filter((row) => row.classList.contains('ds-line')).length;
      const who = run.steps.length
        ? `told in ${run.steps.map(stepName).join(', ')}`
        : 'from other chapters';
      rows[run.from].insertAdjacentHTML(
        'beforebegin',
        `<tr class="ds-narrow"><td colspan="${columnCount()}">⋯ ${lines} line${lines === 1 ? '' : 's'} ${escapeHtml(who)}<button type="button" data-narrow-open>Show</button></td></tr>`,
      );
    }
  }
}

/** Open a fold: its rows show and its "⋯ N lines" row goes. */
export function openRun(fold) {
  for (
    let row = fold.nextElementSibling;
    row && row.classList.contains('ds-out');
    row = row.nextElementSibling
  ) {
    row.classList.remove('ds-out');
  }
  fold.remove();
}

/** Open the fold that holds a row (a jump to one of its lines). */
export function openFold(row) {
  let fold = row.previousElementSibling;
  while (fold && fold.classList.contains('ds-out')) {
    fold = fold.previousElementSibling;
  }
  if (fold && fold.classList.contains('ds-narrow')) {
    openRun(fold);
  }
}

/** A jump from the panel to a file or its lines: unfold the file (Viewed files fold) and open the folds that hold the lines. Viewed stays as it is. */
export function reveal(rel, side, start, end) {
  const file = page.story.local.files.find((candidate) => candidate.rel === rel);
  if (!file) {
    return;
  }
  const section = document.getElementById(`diff-${file.sha}`);
  if (section && section.classList.contains('ds-folded')) {
    section.classList.remove('ds-folded');
    section.querySelector('.ds-fold')?.setAttribute('aria-expanded', 'true');
  }
  if (!side || !Number.isFinite(start)) {
    return;
  }
  for (let line = start; line <= Math.max(start, end || start) && line < start + 400; line++) {
    const cell = document.querySelector(`[data-line-anchor="diff-${file.sha}${side}${line}"]`);
    const row = cell && cell.closest('tr');
    if (row && row.classList.contains('ds-out')) {
      openFold(row);
    }
  }
}
