/*
 * The chapter filter: hides other chapters' files (and their file-tree rows)
 * with display:none, says how many of the chapter's files are on the page,
 * and keeps that true while GitHub loads and re-renders diffs. A #diff-<sha>
 * jump to a file outside the chapter steps on to the next file in it.
 */
import { escapeHtml } from '../util/html.js';
import { baseName, capitalize } from '../util/text.js';

/**
 * A file outside the chapter also gets the standard `hidden` attribute on
 * its block and on the elements other tools look for (Refined GitHub's
 * alt-click "mark all viewed" skips only `[class*=diffTargetable]:not([hidden])`).
 * We only ever remove a `hidden` we added (data-prs-hid marks it).
 */
const TARGETS =
  '[role="region"][id^="diff-"], [class*="diffTargetable"], .js-file, copilot-diff-entry';
const DEBOUNCE_MS = 150;

function setHidden(el, hide) {
  if (hide && !el.hasAttribute('data-prs-hidden')) {
    el.setAttribute('data-prs-hidden', '');
  }
  if (!hide && el.hasAttribute('data-prs-hidden')) {
    el.removeAttribute('data-prs-hidden');
  }
}

function hideBlock(el, hide) {
  setHidden(el, hide);
  const targets = [el, ...el.querySelectorAll(TARGETS)].filter(
    (target, index) => index === 0 || target.matches(TARGETS),
  );
  for (const target of targets) {
    if (hide && !target.hasAttribute('hidden')) {
      target.setAttribute('hidden', '');
      target.setAttribute('data-prs-hid', '');
    }
    if (!hide && target.hasAttribute('data-prs-hid')) {
      target.removeAttribute('hidden');
      target.removeAttribute('data-prs-hid');
    }
  }
}

/** Takes every mark the panel put on the page off again. */
function unhideAll() {
  for (const el of document.querySelectorAll('[data-prs-hidden], [data-prs-flash]')) {
    el.removeAttribute('data-prs-hidden');
    el.removeAttribute('data-prs-flash');
  }
  for (const el of document.querySelectorAll('[data-prs-hid]')) {
    el.removeAttribute('hidden');
    el.removeAttribute('data-prs-hid');
  }
}

// Changes inside a diff line (Refined GitHub's show-whitespace and linkify-code wrap text in spans as you scroll) can't add or remove a file, so they don't count.
const insideLine = (node) => {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!(el && el.closest('td, .diff-text-inner, .blob-code-inner'));
};

export function createFilter(context) {
  const { story, state, opts, page, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let seen = { found: 0, shown: 0, missing: [] };

  /** Shows the chapter's files and hides the rest (all of them show on the Overview or with Show all files). */
  function apply() {
    const wanted = context.inChapter();
    const showAll = state.all || state.n === 0;
    const blocks = page.fileBlocks();
    const onPage = new Set();
    for (const { rel, el } of blocks) {
      onPage.add(rel);
      hideBlock(el, !showAll && !wanted.has(rel));
    }
    const rows = page.treeRows();
    const fileRows = rows.filter((row) => row.rel);
    for (const row of fileRows) {
      setHidden(row.el, !showAll && !wanted.has(row.rel));
    }
    // folders: keep one if a chapter file lives under it or any of its rows is still showing
    for (const row of rows.filter((candidate) => !candidate.rel)) {
      const under = row.dir && [...wanted].some((path) => path.startsWith(row.dir + '/'));
      const visibleChild = fileRows.some(
        (fileRow) => row.el.contains(fileRow.el) && !fileRow.el.hasAttribute('data-prs-hidden'),
      );
      setHidden(row.el, !showAll && !under && !visibleChild);
    }
    seen = {
      found: blocks.length,
      shown: [...wanted].filter((path) => onPage.has(path)).length,
      missing: [...wanted].filter((path) => !onPage.has(path)),
    };
    renderNote();
    context.viewed.render();
    if (opts.onFilter) {
      opts.onFilter({ n: state.n, all: showAll });
    }
  }

  /** The note under the toolbar: how many files show, and Show all files. */
  function renderNote() {
    const total = data.files.length;
    let html;
    if (state.n === 0) {
      html = `<span>Overview: all <b>${total}</b> files, ${data.chapters.length} chapters</span>`;
    } else {
      const count = context.chapter().files.length;
      const extra =
        seen.missing.length && !state.all
          ? ` <span title="${escapeHtml(seen.missing.join('\n'))}">(${seen.missing.length} not loaded on the page yet)</span>`
          : '';
      const here = story.chapterName(state.n);
      html = state.all
        ? `<span>Showing all <b>${total}</b> files. ${capitalize(here)}'s ${count} are listed below.</span> <button class="prs-all" aria-pressed="true">Chapter files only</button>`
        : `<span>Showing <b>${count}</b> of <b>${total}</b> files, ${here}${extra}</span> <button class="prs-all" aria-pressed="false">Show all files</button>`;
    }
    $('.prs-count-note').innerHTML = html;
    const allButton = $('.prs-all');
    if (allButton) {
      allButton.onclick = () => {
        state.all = !state.all;
        context.saveState();
        apply();
      };
    }
    for (const item of shell.root.querySelectorAll('ul.prs-files > li[data-file]')) {
      item.classList.toggle('prs-missing', seen.missing.includes(item.getAttribute('data-file')));
    }
  }

  $('.prs-note').addEventListener('click', (event) => {
    const ref = event.target.closest('[data-rel]');
    if (ref) {
      context.scroll.jumpTo(ref.getAttribute('data-rel'));
    }
  });

  // GitHub loads and re-renders diffs as you scroll, and flips aria-pressed when
  // the reviewer ticks Viewed, so re-filter and refresh the check marks after changes.
  let pending = 0;
  const observer = new MutationObserver((mutations) => {
    const ours = mutations.every(
      (mutation) =>
        mutation.target === shell.host ||
        shell.host.contains(mutation.target) ||
        (mutation.type === 'childList' && insideLine(mutation.target)),
    );
    if (ours) {
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = 0;
        apply();
        if (context.drafts.waitingOnPage()) {
          context.drafts.render();
        }
      }, DEBOUNCE_MS);
    }
  });
  function watch() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
  }

  // ---------- a #diff-<sha> jump to a file outside the chapter
  // Refined GitHub's j/k and "jump to first unviewed file" set the hash to the
  // next file in page order without checking it's visible. Step on, in the same
  // direction, to the next file that is in the chapter.
  let lastHashIndex = -1;
  function onHashChange() {
    const match = /^#diff-([0-9a-f]{64})/.exec(location.hash);
    const rel = match && story.shaToPath.get(match[1]);
    if (!rel) {
      return;
    }
    const blocks = page.fileBlocks();
    const index = blocks.findIndex((block) => block.rel === rel);
    const wanted = context.inChapter();
    if (state.all || state.n === 0 || wanted.has(rel) || index < 0) {
      lastHashIndex = index;
      return;
    }
    const direction = index >= lastHashIndex ? 1 : -1;
    for (let i = index + direction; i >= 0 && i < blocks.length; i += direction) {
      if (!wanted.has(blocks[i].rel)) {
        continue;
      }
      lastHashIndex = i;
      location.replace('#diff-' + story.pathToSha.get(blocks[i].rel));
      return;
    }
    const where = story.chaptersOf(rel);
    shell.message(
      `${baseName(rel)} isn't in this chapter${where.length ? ` (it's in ${where.map(story.chapterName).join(', ')})` : ''}, and there's no chapter file past it.`,
    );
  }
  window.addEventListener('hashchange', onHashChange);

  function destroy() {
    observer.disconnect();
    clearTimeout(pending);
    window.removeEventListener('hashchange', onHashChange);
  }

  return {
    apply,
    renderNote,
    watch,
    unhideAll,
    destroy,
    get seen() {
      return seen;
    },
  };
}
