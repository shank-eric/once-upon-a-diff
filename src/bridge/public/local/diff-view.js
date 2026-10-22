/*
 * The diff, drawn with the same DOM shapes as GitHub's /changes page (file
 * regions with id diff-<sha256(path)>, line cells with data-line-anchor, a
 * role=tree file list, a Viewed toggle with aria-pressed), so the story panel
 * runs on it unchanged. Unified or split, with syntax highlighting when
 * highlight.js has loaded.
 */
import { splitRows } from '/assets/split.js';
import { highlightFile, LIMITS } from '/assets/syntax.js';
import { escapeHtml } from '/assets/util/html.js';
import { page } from './page.js';

export const isSplit = () => !!page.story && page.story.local.diff_view === 'split';
/** How many columns a row spans. */
export const columnCount = () => (isSplit() ? 4 : 3);

// ---------- syntax highlighting (highlight.js, vendored and served by the bridge; the page works without it)
const highlightCache = new Map(); // rel|hash|whitespace -> per hunk, per line HTML (or null: drawn plain)
let highlightBudget = 0;
/** Starts a new page's highlighting budget (a redraw). */
export const resetHighlightBudget = () => {
  highlightBudget = 0;
};
function highlighted(file) {
  const key = `${file.rel}|${file.hash}|${page.story.local.hide_whitespace}`;
  if (highlightCache.has(key)) {
    return highlightCache.get(key);
  }
  const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (highlightBudget + lines > LIMITS.pageLines) {
    return null; // past the page's budget, the rest is plain (and not cached, so a smaller diff gets it)
  }
  highlightBudget += lines;
  const html = highlightFile(file, page.hljs);
  highlightCache.set(key, html);
  return html;
}
/** A line's code: its highlighted HTML when there is some, else the escaped text. */
const codeHtml = (highlights, hunkIndex, lineIndex, text) =>
  highlights && highlights[hunkIndex] && highlights[hunkIndex][lineIndex] != null
    ? highlights[hunkIndex][lineIndex]
    : escapeHtml(text);

/** The file tree, with single-folder chains folded into one row as GitHub does. */
export function treeHtml(rels) {
  const root = { dirs: new Map(), files: [] };
  for (const rel of rels) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(key)) {
        node.dirs.set(key, { name: parts[i], dirs: new Map(), files: [] });
      }
      node = node.dirs.get(key);
    }
    node.files.push(rel);
  }
  const draw = (node, depth) => {
    let html = '';
    for (const [key, dir] of [...node.dirs].sort()) {
      let folderKey = key;
      let folder = dir;
      let label = dir.name;
      while (folder.files.length === 0 && folder.dirs.size === 1) {
        const [nextKey, nextFolder] = [...folder.dirs][0];
        folderKey = nextKey;
        label += '/' + nextFolder.name;
        folder = nextFolder;
      }
      html +=
        `<div role="treeitem" aria-expanded="true" id="${escapeHtml(folderKey)}" class="ds-tree-dir">` +
        `<div class="ds-tree-label" style="padding-left:${8 + depth * 12}px">${escapeHtml(label)}</div>` +
        `<div role="group">${draw(folder, depth + 1)}</div></div>`;
    }
    for (const rel of node.files.sort()) {
      html += `<div role="treeitem" id="${escapeHtml(rel)}" class="ds-tree-file" data-goto="${escapeHtml(rel)}" style="padding-left:${8 + depth * 12}px">${escapeHtml(rel.split('/').pop())}</div>`;
    }
    return html;
  };
  return draw(root, 0);
}

const numberCell = (file, side, number, extra = '') =>
  `<td class="ds-num${extra}" data-line-anchor="diff-${file.sha}${side}${number}" data-side="${side}" data-line="${number}" title="Add a fix-before-push note">${number}</td>`;
const SIGN = { ctx: ' ', del: '-', add: '+' };
const hunkHeader = (hunk) =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${escapeHtml(hunk.header || '')}`;

/** GitHub's split view: four cells a row, old on the left and new on the right, the same line anchors as unified. */
function splitHtml(file) {
  let html = '';
  const highlights = highlighted(file);
  file.hunks.forEach((hunk, hunkIndex) => {
    html += `<tr class="ds-hunk"><td class="ds-num"></td><td class="ds-code" colspan="3">${hunkHeader(hunk)}</td></tr>`;
    for (const row of splitRows(hunk)) {
      if (row.info) {
        html += `<tr class="ds-info"><td class="ds-num"></td><td class="ds-code" colspan="3">${escapeHtml(row.info)}</td></tr>`;
        continue;
      }
      const half = (side, cell, right) =>
        cell
          ? `${numberCell(file, side, cell.num, ` ds-n-${cell.kind}${right ? ' ds-rnum' : ''}`)}<td class="ds-code ds-c-${cell.kind}"><span class="ds-sign">${SIGN[cell.kind]}</span>${codeHtml(highlights, hunkIndex, cell.i, cell.text)}</td>`
          : `<td class="ds-num ds-n-empty${right ? ' ds-rnum' : ''}"></td><td class="ds-code ds-c-empty"></td>`;
      html += `<tr class="ds-line ds-pair">${half('L', row.left, false)}${half('R', row.right, true)}</tr>`;
    }
  });
  return html;
}

function unifiedHtml(file) {
  let html = '';
  const highlights = highlighted(file);
  file.hunks.forEach((hunk, hunkIndex) => {
    html += `<tr class="ds-hunk"><td class="ds-num"></td><td class="ds-num"></td><td class="ds-code">${hunkHeader(hunk)}</td></tr>`;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    hunk.lines.forEach((line, i) => {
      const sign = line[0];
      const text =
        sign === ' ' || sign === '-' || sign === '+'
          ? codeHtml(highlights, hunkIndex, i, line.slice(1))
          : escapeHtml(line.slice(1));
      const cell = (side, number) => numberCell(file, side, number);
      if (sign === ' ') {
        html += `<tr class="ds-line ds-ctx">${cell('L', oldLine)}${cell('R', newLine)}<td class="ds-code"><span class="ds-sign"> </span>${text}</td></tr>`;
        oldLine++;
        newLine++;
      } else if (sign === '-') {
        html += `<tr class="ds-line ds-del">${cell('L', oldLine)}<td class="ds-num"></td><td class="ds-code"><span class="ds-sign">-</span>${text}</td></tr>`;
        oldLine++;
      } else if (sign === '+') {
        html += `<tr class="ds-line ds-add"><td class="ds-num"></td>${cell('R', newLine)}<td class="ds-code"><span class="ds-sign">+</span>${text}</td></tr>`;
        newLine++;
      } else {
        html += `<tr class="ds-info"><td class="ds-num"></td><td class="ds-num"></td><td class="ds-code">${text}</td></tr>`;
      }
    });
  });
  return html;
}

function rowsHtml(file) {
  if (file.binary) {
    return `<tr class="ds-info"><td colspan="${columnCount()}">Binary file</td></tr>`;
  }
  if (file.whitespace_only) {
    return `<tr class="ds-info"><td colspan="${columnCount()}">Only whitespace changes, hidden. Turn off Hide whitespace to see them.</td></tr>`;
  }
  if (!file.hunks.length) {
    return `<tr class="ds-info"><td colspan="${columnCount()}">${file.kind === 'renamed' ? 'Renamed without changes' : 'No changed lines'}</td></tr>`;
  }
  return isSplit() ? splitHtml(file) : unifiedHtml(file);
}

const columnsHtml = () =>
  isSplit()
    ? '<col class="ds-col-num"><col><col class="ds-col-num"><col>'
    : '<col class="ds-col-num"><col class="ds-col-num"><col>';

function kindOf(file) {
  if (file.kind === 'renamed' && file.renamed_from) {
    return `renamed from ${file.renamed_from}`;
  }
  return file.kind === 'modified' ? '' : file.kind;
}

export function fileHtml(file) {
  const kind = kindOf(file);
  return `<div class="ds-file-wrap"><section role="region" class="ds-file${file.viewed ? ' ds-folded' : ''}" id="diff-${file.sha}" data-path="${escapeHtml(file.rel)}" aria-label="${escapeHtml(file.rel)}">
    <header class="ds-file-head">
      <button class="ds-fold" type="button" aria-label="Fold or unfold this file" aria-expanded="${!file.viewed}"></button>
      <code class="ds-path">${escapeHtml(file.rel)}</code>
      ${kind ? `<span class="ds-kind">${escapeHtml(kind)}</span>` : ''}
      ${file.whitespace_only ? '<span class="ds-kind" title="Hide whitespace is on">whitespace only</span>' : ''}
      <span class="ds-stat"><span class="ds-plus">+${file.stats.added}</span> <span class="ds-minus">−${file.stats.removed}</span></span>
      ${file.viewed_changed ? '<span class="ds-changed" title="You marked this viewed, and its diff has changed since">changed since viewed</span>' : ''}
      <button class="ds-viewed" type="button" aria-pressed="${file.viewed ? 'true' : 'false'}">Viewed</button>
    </header>
    <div class="ds-file-body"><table class="ds-diff${isSplit() ? ' ds-split' : ''}"><colgroup>${columnsHtml()}</colgroup><tbody>${rowsHtml(file)}</tbody></table></div>
  </section></div>`;
}

/** "repo · base abc1234 → head def5678 · branch" */
const rangeHtml = (local) =>
  `${escapeHtml(local.repo)} · <code>${escapeHtml(local.base)}</code> ${escapeHtml(local.base_oid.slice(0, 9))}` +
  ` → <code>${escapeHtml(local.head)}</code> ${escapeHtml(local.head_oid.slice(0, 9))}` +
  `${local.branch ? ` · ${escapeHtml(local.branch)}` : ''}`;
/** "3 commits · 4 files +10 −2" */
const sizeHtml = (local, added, removed) =>
  `${local.commits.length} commit${local.commits.length === 1 ? '' : 's'} · ${local.files.length} files ` +
  `<span class="ds-plus">+${added}</span> <span class="ds-minus">−${removed}</span>`;

/** The top bar: the range, its size, the diff view, Hide whitespace and the notes toggle. */
export function headerHtml() {
  const { story } = page;
  const local = story.local;
  const added = local.files.reduce((sum, file) => sum + file.stats.added, 0);
  const removed = local.files.reduce((sum, file) => sum + file.stats.removed, 0);
  const open = local.notes.filter((note) => !note.done).length;
  return `<header class="ds-top">
    <div class="ds-top-main">
      <h1>${escapeHtml(story.title)}</h1>
      <div class="ds-muted">${rangeHtml(local)} · ${sizeHtml(local, added, removed)}</div>
    </div>
    <div class="ds-view" role="group" aria-label="Diff view"><button type="button" data-diff-view="unified" aria-pressed="${!isSplit()}">Unified</button><button type="button" data-diff-view="split" aria-pressed="${isSplit()}">Split</button></div>
    <label class="ds-ws" title="Draw the diff with git diff -w, like GitHub's Hide whitespace. Remembered for every local story."><input type="checkbox" class="ds-ws-toggle"${local.hide_whitespace ? ' checked' : ''}> Hide whitespace</label>
    <button type="button" class="ds-notes-toggle" aria-expanded="false">Fix before push: ${open} open</button>
  </header>
  <section class="ds-notes-list" hidden></section>`;
}
