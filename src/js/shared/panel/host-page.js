/*
 * Finding files, lines, Viewed toggles and expand controls on the host page:
 * GitHub's /changes and /files, or the local page, whose diff view uses the
 * same DOM shapes as /changes. Read only: nothing here clicks anything.
 *
 * Selectors (checked against github.com 2026-10-20):
 *   /changes  file:   [role=region][id="diff-<sha256(path)>"], wrapped by a
 *                     one-child div inside [data-testid=progressive-diffs-list]
 *             line:   [data-line-anchor="diff-<sha>R<n>"] (L<n> for removed lines)
 *             viewed: header button[aria-pressed] whose text is "Viewed" (clicked only by Mark viewed)
 *             tree:   [role=tree] [role=treeitem], id = file or folder path
 *             expand: header button labelled "Expand file" (aria-labelledby) when collapsed;
 *                     hunk rows hold td.diff-hunk-cell and button[data-direction=up|down|all];
 *                     a context row's old line is only in data-diff-line-key (b:N-l:N-r:N);
 *                     "Expand all lines: <path>" (.js-expand-all-difflines-button) opens the file
 *   /files    file:   copilot-diff-entry[data-file-path] or .file[data-tagsearch-path]
 *             line:   #diff-<sha>R<n>
 *             viewed: input.js-reviewed-checkbox (clicked only by Mark viewed)
 *             tree:   file-tree li[data-tree-entry-type] with a[href="#diff-<sha>"]
 *             expand: .file-header .js-details-target "Toggle diff contents" [aria-expanded=false];
 *                     tr.js-expandable-line holds a.js-expand "Expand Up|Down|All"
 */
import { expandDirOf } from './expand.js';

const LINE_ID = /^diff-([0-9a-f]{64})([LR])(\d+)$/;

/** Is this element drawn (on the page and not display:none)? */
export const isDrawn = (element) => !!element && element.getClientRects().length > 0;

/** Climb through one-child wrappers, so the gap GitHub leaves between files goes too. */
function outerWrapper(element) {
  let wrapper = element;
  for (
    let depth = 0;
    depth < 3 &&
    wrapper.parentElement &&
    wrapper.parentElement.children.length === 1 &&
    wrapper.parentElement !== document.body;
    depth++
  ) {
    wrapper = wrapper.parentElement;
  }
  return wrapper;
}

/** A control's accessible name: aria-label, the text of its aria-labelledby elements, or its title. */
export function labelOf(element) {
  const ids = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  const labelledBy = ids
    .map((id) => {
      const labelElement = document.getElementById(id);
      return labelElement ? labelElement.textContent : '';
    })
    .join(' ')
    .trim();
  return (
    element.getAttribute('aria-label') ||
    labelledBy ||
    element.getAttribute('title') ||
    ''
  ).trim();
}

/** The adapters, for one story's files. */
export function createHostPage({ shaToPath, pathToSha, allPaths, hostId, panelId }) {
  /** The page's file blocks: [{rel, el}], el being what gets hidden. */
  function fileBlocks() {
    const found = new Map();
    const add = (rel, el) => {
      if (rel && el && allPaths.has(rel) && !found.has(el)) {
        found.set(el, rel);
      }
    };
    for (const el of document.querySelectorAll('[id^="diff-"]')) {
      const rel = shaToPath.get(el.id.slice(5));
      if (rel) {
        add(rel, el.closest('copilot-diff-entry') || outerWrapper(el));
      }
    }
    for (const el of document.querySelectorAll(
      'copilot-diff-entry[data-file-path], .file[data-tagsearch-path], .js-file[data-tagsearch-path]',
    )) {
      add(
        el.getAttribute('data-file-path') || el.getAttribute('data-tagsearch-path'),
        el.closest('copilot-diff-entry') || el,
      );
    }
    return [...found].map(([el, rel]) => ({ rel, el }));
  }
  const blockOf = (rel) => fileBlocks().find((block) => block.rel === rel);
  /** The page's file blocks by path. */
  const blocksByPath = () => new Map(fileBlocks().map((block) => [block.rel, block]));

  /** The cell for line `line` on `side` ('L' old, 'R' new) of a file, or null. */
  function lineCell(rel, side, line) {
    const sha = pathToSha.get(rel);
    const id = `diff-${sha}${side}${line}`;
    // /changes puts the anchor of the line before a gap on its hunk row too, so that one doesn't count
    const cell =
      [...document.querySelectorAll(`[data-line-anchor="${id}"]`)].find(
        (candidate) => !candidate.closest('.diff-hunk-cell'),
      ) || document.getElementById(id);
    if (cell || side !== 'L') {
      return cell;
    }
    // /changes anchors an unchanged line by its new number only; its old one is in data-diff-line-key
    return document.querySelector(
      `table[data-diff-anchor="diff-${sha}"] .diff-line-number-neutral[data-diff-line-key*="-l:${line}-"]`,
    );
  }

  /** A file block's own Viewed toggle: /changes' (and the local page's) header button, or classic /files' checkbox. */
  const viewedToggleIn = (el) =>
    [...el.querySelectorAll('button[aria-pressed]')].find((button) =>
      /^\s*viewed\s*$/i.test(button.textContent),
    ) ||
    el.querySelector('input.js-reviewed-checkbox') ||
    null;

  /**
   * true/false from the file header's Viewed toggle, null when the file isn't on the page,
   * or 'none' when it is but has no Viewed toggle (logged out, say). Never clicks it.
   */
  function isViewed(rel, blocks) {
    const block = blocks ? blocks.get(rel) : blockOf(rel);
    if (!block) {
      return null;
    }
    const toggle = viewedToggleIn(block.el);
    if (!toggle) {
      return 'none';
    }
    return toggle.matches('input')
      ? toggle.checked
      : toggle.getAttribute('aria-pressed') === 'true';
  }

  /** Never a Viewed toggle, a checkbox or anything that submits: those aren't ours to click. */
  const isSafeToClick = (el) =>
    !!el &&
    el.isConnected &&
    !el.hasAttribute('aria-pressed') &&
    !el.matches('input, [type="submit"], .js-reviewed-toggle, .js-reviewed-checkbox') &&
    !el.closest('#' + hostId);

  /** The file's own expand toggle while it's collapsed, else null. */
  function collapsedToggle(el) {
    // /changes
    for (const button of el.querySelectorAll('button')) {
      if (/^expand file$/i.test(labelOf(button)) && isSafeToClick(button)) {
        return button;
      }
    }
    // /files
    for (const button of el.querySelectorAll(
      '.file-header .js-details-target[aria-expanded="false"]',
    )) {
      if (/toggle diff contents/i.test(labelOf(button)) && isSafeToClick(button)) {
        return button;
      }
    }
    return null;
  }
  /** "Load diff", on a large or generated file GitHub doesn't draw until asked. */
  const loadDiffButton = (el) =>
    [...el.querySelectorAll('button')].find(
      (button) => /^\s*load diff\s*$/i.test(button.textContent) && isSafeToClick(button),
    ) || null;
  /** /changes' "Expand all lines: <path>" header button, which draws the whole file. */
  const expandAllButton = (el) =>
    [...el.querySelectorAll('button')].find(
      (button) =>
        (button.classList.contains('js-expand-all-difflines-button') ||
          /^expand all lines\b/i.test(labelOf(button))) &&
        isSafeToClick(button),
    ) || null;

  /** One row of a file's table, for expandStep: {gap, controls} for a hunk row, else {n} on that side. */
  function rowModel(row, sha, side) {
    const controls = [...row.querySelectorAll('button[data-direction], .js-expand')];
    if (
      controls.length ||
      row.matches('.js-expandable-line') ||
      row.querySelector('.diff-hunk-cell, .blob-code-hunk')
    ) {
      const byDirection = {};
      for (const control of controls) {
        const direction = expandDirOf(control.getAttribute('data-direction'), labelOf(control));
        if (direction && !byDirection[direction] && isSafeToClick(control)) {
          byDirection[direction] = control;
        }
      }
      return { gap: Object.keys(byDirection), controls: byDirection };
    }
    let line = null;
    for (const cell of row.querySelectorAll('[data-line-anchor], td[id^="diff-"]')) {
      const match = LINE_ID.exec(cell.getAttribute('data-line-anchor') || cell.id);
      if (match && match[1] === sha && match[2] === side) {
        line = +match[3];
        break;
      }
    }
    if (line == null && side === 'L') {
      const keyCell = row.querySelector('.diff-line-number-neutral[data-diff-line-key]');
      const match =
        keyCell && /(?:^|-)l:(\d+)(?:-|$)/.exec(keyCell.getAttribute('data-diff-line-key'));
      if (match) {
        line = +match[1];
      }
    }
    return { n: line };
  }

  /** File-tree rows: [{rel|dir, el}]. */
  function treeRows() {
    const rows = [];
    for (const el of document.querySelectorAll('[role="tree"] [role="treeitem"]')) {
      if (el.closest('#' + panelId)) {
        continue;
      }
      const id = el.id || '';
      if (allPaths.has(id)) {
        rows.push({ rel: id, el });
      } else if (el.hasAttribute('aria-expanded')) {
        rows.push({ dir: id, el });
      }
    }
    for (const el of document.querySelectorAll(
      'file-tree li[data-tree-entry-type], .js-tree-node',
    )) {
      const link = el.querySelector(
        ':scope > a[href*="#diff-"], :scope > .ActionList-content[href*="#diff-"]',
      );
      const type = el.getAttribute('data-tree-entry-type');
      if (link && type !== 'directory' && type !== 'root') {
        rows.push({ rel: shaToPath.get(link.getAttribute('href').split('#diff-')[1]), el });
      } else if (type === 'directory' || type === 'root') {
        rows.push({ dir: null, el });
      }
    }
    return rows;
  }

  /** The file at the top of the screen (under GitHub's sticky header), else the next one down that shows. */
  function fileAtTop() {
    const topY = 140;
    let best = null;
    for (const { rel, el } of fileBlocks()) {
      if (el.hasAttribute('data-dsm-hidden')) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.height) {
        continue;
      }
      if (rect.top <= topY && rect.bottom > topY) {
        return rel;
      }
      if (rect.top > topY && (!best || rect.top < best.top)) {
        best = { rel, top: rect.top };
      }
    }
    return best && best.top < window.innerHeight ? best.rel : null;
  }

  return {
    isDrawn,
    labelOf,
    fileBlocks,
    blockOf,
    blocksByPath,
    lineCell,
    viewedToggleIn,
    isViewed,
    isSafeToClick,
    collapsedToggle,
    loadDiffButton,
    expandAllButton,
    rowModel,
    treeRows,
    fileAtTop,
  };
}
