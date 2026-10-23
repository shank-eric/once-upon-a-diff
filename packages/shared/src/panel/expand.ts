// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Expanding a file's diff to a line. A file or line link in the panel is the
 * only thing that clicks expand controls: the file's own expand toggle if it's
 * collapsed (Viewed and large files collapse), "Load diff", then the hunk
 * expanders until the line is on the page. GitHub fetches the lines with the
 * page's own settings, so ?w=1 holds. Never a step change on its own.
 *
 * expandDirOf and expandStep have no DOM, so node tests can use them.
 */

/** Which way an expand control opens: 'up', 'down' or 'all', from data-direction or its label ("Expand Up", "Expand file down from line 82"). */
export function expandDirOf(direction, label) {
  const dataDirection = String(direction || '').toLowerCase();
  if (dataDirection === 'up' || dataDirection === 'down' || dataDirection === 'all') {
    return dataDirection;
  }
  const text = String(label || '').toLowerCase();
  if (/\bup\b/.test(text)) {
    return 'up';
  }
  if (/\bdown\b/.test(text)) {
    return 'down';
  }
  if (/\ball\b|\bfrom line \d+ to line\b/.test(text)) {
    return 'all';
  }
  return null;
}

/**
 * The next expand control to click to bring `line` into a file's diff.
 * rows is the file's table in page order: {gap: ['up', 'down', 'all']} for a hunk row
 * (the expand controls it has, maybe none), or {n} for a drawn row (n is its line number
 * on the wanted side, or null when it has none there, like an added row on the old side).
 * Returns {at, dir, far}: the gap row's index, the control, and how far the line is from
 * the drawn line that control opens from. null when no gap holds the line.
 */
export function expandStep(rows, line) {
  for (let i = 0; i < rows.length; i++) {
    const directions = rows[i].gap;
    if (!directions) {
      continue;
    }
    let before = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (!rows[j].gap && rows[j].n != null) {
        before = rows[j].n;
        break;
      }
    }
    let after = Infinity;
    for (let j = i + 1; j < rows.length; j++) {
      if (!rows[j].gap && rows[j].n != null) {
        after = rows[j].n;
        break;
      }
    }
    if (!(before < line && line < after)) {
      continue;
    }
    if (directions.includes('all')) {
      return { at: i, dir: 'all', far: Math.min(line - before, after - line) };
    }
    const canUp = directions.includes('up');
    const canDown = directions.includes('down');
    if (!canUp && !canDown) {
      return null;
    }
    // "down" opens the lines under the drawn line above the gap, "up" the lines over the one below it
    let direction;
    if (canUp && canDown) {
      direction = line - before <= after - line ? 'down' : 'up';
    } else {
      direction = canUp ? 'up' : 'down';
    }
    return { at: i, dir: direction, far: direction === 'up' ? after - line : line - before };
  }
  return null;
}

/** A line farther than this from the nearest drawn line opens the whole file in one click, where the page has a button for that. */
export const EXPAND_ALL_FAR = 60;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(test, milliseconds) {
  for (const end = Date.now() + milliseconds; Date.now() < end; await pause(100)) {
    const value = test();
    if (value) {
      return value;
    }
  }
  return test();
}

/** expandTo, for one panel. A newer call (or cancel) makes an older one stop between clicks. */
export function createExpander(context) {
  const { page } = context;
  let token = 0;

  /**
   * Open a file (and, with a line, the hunks around it) until the line is drawn.
   * Clicks only the file's expand toggle, Load diff and hunk expanders, so Viewed stays as it is.
   * Resolves to true when the file (or line) is on the page, false when it can't get there.
   */
  async function expandTo(rel, side, line) {
    const mine = ++token;
    const live = () => mine === token && context.shell.host.isConnected;
    const sha = context.story.pathToSha.get(rel);
    let block = page.blockOf(rel);
    if (!block || !sha) {
      return false;
    }
    const toggle = page.collapsedToggle(block.el);
    if (toggle) {
      toggle.click();
      await waitFor(() => {
        const current = page.blockOf(rel);
        return current && !page.collapsedToggle(current.el) && current.el.querySelector('tr');
      }, 6000);
    }
    block = page.blockOf(rel);
    const loadButton = block && page.loadDiffButton(block.el);
    if (live() && loadButton) {
      loadButton.click();
      await waitFor(() => {
        const current = page.blockOf(rel);
        return current && !page.loadDiffButton(current.el) && current.el.querySelector('tr');
      }, 10000);
    }
    if (line == null) {
      return live();
    }
    for (let attempt = 0; attempt < 40 && live(); attempt++) {
      if (page.isDrawn(page.lineCell(rel, side, line))) {
        return true;
      }
      block = page.blockOf(rel);
      if (!block) {
        return false;
      }
      const tableRows = [...block.el.querySelectorAll('tr')];
      const rows = tableRows.map((row) => page.rowModel(row, sha, side));
      const step = expandStep(rows, line);
      if (!step) {
        return false;
      }
      const allButton = step.far > EXPAND_ALL_FAR ? page.expandAllButton(block.el) : null;
      const control = allButton || rows[step.at].controls[step.dir];
      if (!page.isSafeToClick(control)) {
        return false;
      }
      const labelBefore = page.labelOf(control);
      control.click();
      const moved = await waitFor(() => {
        const current = page.blockOf(rel);
        return (
          current &&
          (!control.isConnected ||
            current.el.querySelectorAll('tr').length !== tableRows.length ||
            page.labelOf(control) !== labelBefore)
        );
      }, 8000);
      if (!moved) {
        return false;
      }
    }
    return live() && page.isDrawn(page.lineCell(rel, side, line));
  }

  return {
    expandTo,
    /** The latest expandTo's number: a jump that waited on it checks it's still the latest. */
    get token() {
      return token;
    },
    cancel() {
      token++;
    },
  };
}
