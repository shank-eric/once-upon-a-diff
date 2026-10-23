// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Jumping to a file or lines from a link in the panel: open the file if it's
 * collapsed (expand.js), scroll it under GitHub's header, and highlight it
 * for a few seconds. GitHub renders files as a long jump passes them, which
 * moves the target, so the scroll is settled again for ≈2s.
 */
import { baseName } from '../util/text.ts';

const FLASH_MS = 4000;
const SETTLE_DELAYS = [80, 200, 400, 700, 1100, 1600, 2200];
const SETTLE_SLACK_PX = 24;
const HEADER_PX = 72;

export function createScroller(context) {
  const { story, opts, page, shell } = context;
  const { message } = shell;
  const host = context.hostName;

  // Highlight rows for a few seconds. GitHub's React view can swap a row for a new
  // element as it renders around the scroll, so the rows are found again (getElements) each time.
  let flashTimer = 0;
  let flashing = () => [];
  function clearFlash() {
    for (const el of document.querySelectorAll('[data-ou-flash]')) {
      el.removeAttribute('data-ou-flash');
    }
  }
  function flash(getElements) {
    const find = typeof getElements === 'function' ? getElements : () => getElements;
    clearFlash();
    flashing = find;
    for (const el of find()) {
      el.setAttribute('data-ou-flash', '');
    }
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashing = () => [];
      clearFlash();
    }, FLASH_MS);
  }

  /** Where on the screen a target goes: under the header, or a share of the window's height. */
  const spot = (share) => (share ? window.innerHeight * share : HEADER_PX);
  function scrollWindowTo(el, share) {
    const top = el.getBoundingClientRect().top + window.scrollY - spot(share);
    window.scrollTo({ top: Math.max(0, top) });
  }

  // A long jump makes GitHub render the files it passes, which pushes the target
  // down after the first scroll. So look again for ≈2s and scroll back onto it,
  // until it holds still or the reviewer scrolls.
  let settleToken = 0;
  function settle(getElement, share) {
    const mine = ++settleToken;
    let ours = true;
    const stop = () => {
      ours = false;
    };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    const listenerOptions = { passive: true, capture: true };
    for (const type of events) {
      window.addEventListener(type, stop, listenerOptions);
    }
    // (the mousedown of the click that started this has already happened, so only a new one stops it)
    SETTLE_DELAYS.forEach((delay, index) =>
      setTimeout(() => {
        const last = index === SETTLE_DELAYS.length - 1;
        if (mine === settleToken && ours) {
          const el = getElement();
          if (el && Math.abs(el.getBoundingClientRect().top - spot(share)) > SETTLE_SLACK_PX) {
            scrollWindowTo(el, share);
          }
          for (const row of flashing()) {
            if (!row.hasAttribute('data-ou-flash')) {
              row.setAttribute('data-ou-flash', '');
            }
          }
        }
        if (last) {
          for (const type of events) {
            window.removeEventListener(type, stop, listenerOptions);
          }
        }
      }, delay),
    );
  }

  function scrollToFile(rel, quiet) {
    const block = page.blockOf(rel);
    if (!block) {
      if (!quiet) {
        message(`${rel} isn't loaded on the page yet. Scroll the diff and try again.`);
      }
      return false;
    }
    scrollWindowTo(block.el);
    if (!quiet) {
      flash(() => {
        const current = page.blockOf(rel);
        return current ? [current.el] : [];
      });
    }
    settle(() => {
      const current = page.blockOf(rel);
      return current && current.el;
    });
    return true;
  }

  /** The drawn line nearest `line` on this file's side, when the page doesn't have that one. */
  function nearestDrawnLine(rel, side, line) {
    const prefix = `diff-${story.pathToSha.get(rel)}${side}`;
    return [...document.querySelectorAll(`[data-line-anchor^="${prefix}"]`)]
      .filter((cell) => !cell.closest('.diff-hunk-cell') && page.isDrawn(cell))
      .map((cell) => ({ cell, line: +cell.getAttribute('data-line-anchor').slice(prefix.length) }))
      .filter((candidate) => candidate.line > 0)
      .sort((first, second) => Math.abs(first.line - line) - Math.abs(second.line - line))[0];
  }

  /** Scroll a line range into view and highlight it. jumpTo expands the file and hunks first. */
  function scrollToLine(rel, side, startLine, endLine) {
    if (opts.reveal) {
      opts.reveal(rel, side, startLine, endLine || startLine);
    }
    let target = page.lineCell(rel, side, startLine);
    if (!page.isDrawn(target)) {
      target = null;
    }
    let note = '';
    let atLine = startLine;
    if (!target) {
      const near = nearestDrawnLine(rel, side, startLine);
      if (near) {
        target = near.cell;
        atLine = near.line;
        note = `Line ${startLine} isn't in the diff ${host} can show, so this is the nearest line, ${near.line}.`;
      }
    }
    if (!target) {
      scrollToFile(rel, true);
      message(
        `Line ${startLine} of ${baseName(rel)} isn't on the page, and the file wouldn't open. Scroll to it, open it in ${host}, then click again.`,
      );
      return false;
    }
    const rowOf = (cell) => cell.closest('tr') || cell;
    const rowsNow = () => {
      const rows = [];
      const last = Math.max(startLine, endLine || startLine);
      for (let line = startLine; line <= last && line < startLine + 400; line++) {
        const cell = page.lineCell(rel, side, line);
        if (cell && !rows.includes(rowOf(cell))) {
          rows.push(rowOf(cell));
        }
      }
      if (!rows.length) {
        const cell = page.lineCell(rel, side, atLine);
        if (cell) {
          rows.push(rowOf(cell));
        }
      }
      return rows;
    };
    scrollWindowTo(rowOf(target), 0.25);
    flash(rowsNow);
    settle(() => {
      const cell = page.lineCell(rel, side, atLine);
      return cell && rowOf(cell);
    }, 0.25);
    message(note);
    return true;
  }

  /**
   * A click on a file or line link in the panel: open the file if it's collapsed (or
   * not drawn until asked) and the hunks around the line, then scroll and highlight.
   * Only this expands anything, never a step change or a page change on its own.
   */
  async function jumpTo(rel, line) {
    if (opts.reveal) {
      if (line) {
        opts.reveal(rel, line.side, line.start, line.end);
      } else {
        opts.reveal(rel);
      }
    }
    const block = page.blockOf(rel);
    const ready =
      !block ||
      (!page.collapsedToggle(block.el) &&
        !page.loadDiffButton(block.el) &&
        (!line || page.isDrawn(page.lineCell(rel, line.side, line.start))));
    if (!ready) {
      message(`Opening ${baseName(rel)}${line ? ` at line ${line.start}` : ''}…`);
      scrollToFile(rel, true);
      const token = context.expander.token + 1; // expandTo takes this one
      await context.expander.expandTo(rel, line ? line.side : null, line ? line.start : null);
      if (token !== context.expander.token || !shell.host.isConnected) {
        return; // a newer click took over, or the panel closed
      }
      message('');
    }
    if (line) {
      scrollToLine(rel, line.side, line.start, line.end);
    } else {
      scrollToFile(rel);
    }
  }

  function destroy() {
    clearTimeout(flashTimer);
    settleToken++;
  }

  return { jumpTo, scrollToFile, scrollToLine, destroy };
}
