/**
 * A stand-in for a logged-in GitHub /changes page, for the browser tests:
 * logged out, GitHub sends /changes to classic /files, which the panel no
 * longer reads. The test serves it at the PR's real /changes URL (Playwright's
 * route), so the content script docks on it as on GitHub.
 *
 * It draws the DOM shapes host-page.js reads on /changes (checked against
 * github.com 2026-10-20): file regions, line anchors, data-diff-line-key on a
 * context row's old number, hunk rows with data-direction expanders (one
 * "all" for a gap of 20 lines or fewer, else 20 at a time down and up),
 * "Expand all lines", Collapse/Expand file, a Viewed toggle that collapses the
 * file, the role=tree file list, and the PR title the story tag goes by.
 *
 *   changesPage([{ rel, lines, hunks: [[first, last], ...], added: [n, ...] }])
 *
 * lines is the file's length on the new side, hunks are the new-side ranges
 * drawn at first, and added are new-side lines that are additions (each other
 * line in a hunk is context, and old-side numbers skip the added ones).
 */
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Runs in the page: draws the files and answers their buttons, as GitHub's React does. */
function drawChangesPage(files) {
  const GAP_STEP = 20; // the lines one expand click opens, and the most one "all" button opens
  const escapeText = (text) =>
    String(text).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const tree = document.querySelector('[role="tree"]');
  const list = document.querySelector('[data-testid="progressive-diffs-list"]');
  const folders = new Set();
  for (const file of files) {
    const folder = file.rel.split('/').slice(0, -1).join('/');
    if (folder && !folders.has(folder)) {
      folders.add(folder);
      tree.insertAdjacentHTML(
        'beforeend',
        `<li role="treeitem" aria-expanded="true" id="${escapeText(folder)}">${escapeText(folder)}</li>`,
      );
    }
    tree.insertAdjacentHTML(
      'beforeend',
      `<li role="treeitem" id="${escapeText(file.rel)}">${escapeText(file.rel.split('/').pop())}</li>`,
    );
    // every line of the file, in order; `shown` holds the ones drawn
    const rows = [];
    let oldLine = 0;
    for (let newLine = 1; newLine <= file.lines; newLine++) {
      const isAdded = file.added.includes(newLine);
      rows.push({ L: isAdded ? null : ++oldLine, R: newLine, isAdded });
    }
    const shown = new Set(
      rows.filter((row) => file.hunks.some(([first, last]) => first <= row.R && row.R <= last)),
    );
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div role="region" id="diff-${file.sha}" class="Diff-module__diffTargetable__fixture">
        <div class="file-header">
          <span id="toggle-${file.sha}" class="sr-only">Collapse file</span>
          <button type="button" data-act="toggle" aria-labelledby="toggle-${file.sha}">▾</button>
          <a href="#diff-${file.sha}">${escapeText(file.rel)}</a>
          <button type="button" data-act="all" class="js-expand-all-difflines-button" aria-label="Expand all lines: ${escapeText(file.rel)}">⇕</button>
          <button type="button" data-act="viewed" aria-pressed="false">Viewed</button>
        </div>
        <div class="diff-body"><table data-diff-anchor="diff-${file.sha}"><tbody></tbody></table></div>
      </div>`;
    list.append(wrapper);
    const region = wrapper.firstElementChild;
    const body = region.querySelector('tbody');
    const anchor = (side, line) => `diff-${file.sha}${side}${line}`;
    // a context row's old number is only in data-diff-line-key, as on /changes
    const lineRow = (row, index) =>
      '<tr>' +
      (row.isAdded
        ? '<td class="diff-line-number-addition"></td>'
        : `<td class="diff-line-number-neutral" data-diff-line-key="b:${index}-l:${row.L}-r:${row.R}">${row.L}</td>`) +
      `<td class="diff-line-number" data-line-anchor="${anchor('R', row.R)}">${row.R}</td>` +
      `<td class="diff-text">${row.isAdded ? '+' : ' '} line ${row.R}</td></tr>`;
    const gapRow = (index, directions, before) =>
      `<tr data-gap="${index}">` +
      (before ? `<td data-line-anchor="${anchor('R', before.R)}"></td>` : '<td></td>') +
      `<td class="diff-hunk-cell" colspan="2">${directions
        .map(
          (direction) =>
            `<button type="button" data-direction="${direction}" aria-label="Expand file ${direction}">${direction}</button>`,
        )
        .join('')} @@</td></tr>`;
    const draw = () => {
      let html = '';
      for (let index = 0; index < rows.length;) {
        if (shown.has(rows[index])) {
          html += lineRow(rows[index], index);
          index++;
          continue;
        }
        let end = index;
        while (end < rows.length && !shown.has(rows[end])) {
          end++;
        }
        let directions = ['down', 'up'];
        if (index === 0) {
          directions = ['up'];
        } else if (end === rows.length) {
          directions = ['down'];
        } else if (end - index <= GAP_STEP) {
          directions = ['all'];
        }
        html += gapRow(index, directions, rows[index - 1]);
        index = end;
      }
      body.innerHTML = html;
    };
    const setCollapsed = (collapsed) => {
      region.querySelector('.diff-body').hidden = collapsed;
      document.getElementById(`toggle-${file.sha}`).textContent = collapsed
        ? 'Expand file'
        : 'Collapse file';
    };
    region.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) {
        return;
      }
      const act = button.getAttribute('data-act');
      const direction = button.getAttribute('data-direction');
      if (act === 'toggle') {
        setCollapsed(!region.querySelector('.diff-body').hidden);
      } else if (act === 'viewed') {
        const viewed = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(viewed));
        setCollapsed(viewed);
      } else if (act === 'all') {
        rows.forEach((row) => shown.add(row));
      } else if (direction) {
        // GitHub fetches the lines; here they're already known
        const start = Number(button.closest('tr').getAttribute('data-gap'));
        let end = start;
        while (end < rows.length && !shown.has(rows[end])) {
          end++;
        }
        let gap = rows.slice(start, end);
        if (direction === 'down') {
          gap = gap.slice(0, GAP_STEP);
        } else if (direction === 'up') {
          gap = gap.slice(-GAP_STEP);
        }
        gap.forEach((row) => shown.add(row));
      }
      if (act === 'all' || direction) {
        setTimeout(draw, 150); // after a fetch's worth of delay
      }
    });
    draw();
  }
}

/** The page's HTML, for route.fulfill. */
export function changesPage(files) {
  const model = files.map((file) => ({ added: [], ...file, sha: sha256(file.rel) }));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Files changed</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 0; display: flex; }
  nav { width: 260px; flex: none; } main { flex: 1; padding-top: 64px; }
  .file-header { position: sticky; top: 0; background: #f6f8fa; padding: 6px; border: 1px solid #d0d7de; }
  table { border-collapse: collapse; width: 100%; font: 12px ui-monospace, monospace; }
  td { padding: 0 8px; white-space: pre; } .diff-hunk-cell { background: #ddf4ff; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style></head>
<body>
<nav><ul role="tree" aria-label="File tree"></ul></nav>
<main><div data-component="PH_Title"><h1>A pull request</h1></div>
<div data-testid="progressive-diffs-list"></div></main>
<script>(${drawChangesPage.toString()})(${JSON.stringify(model)});</script>
</body></html>`;
}

/** Serves changesPage(files) at a PR's /changes URL (with any query) on this Playwright page. */
export async function serveChangesPage(page, { owner, repo, number }, files) {
  const html = changesPage(files);
  await page.route(
    (url) => url.pathname === `/${owner}/${repo}/pull/${number}/changes`,
    (route) => route.fulfill({ contentType: 'text/html', body: html }),
  );
}
