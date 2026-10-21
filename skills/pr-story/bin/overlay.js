/*
 * pr-story GitHub overlay. `pr-story.mjs overlay` prints this file followed by
 * `prStoryOverlay(<data>)`, and the result is run in the PR's /changes (or
 * classic /files) page.
 *
 * It only adds a side panel, hides other chapters' files with display:none and
 * scrolls the page. No network calls, no clicks on GitHub controls (Viewed,
 * expand, comment, review), no forms, no dialogs, no storage. A reload removes
 * it. Running it again replaces it. To re-run newer overlay code on the same
 * data: prStoryOverlay(window.__prStoryOverlay.data).
 *
 * Steps: 0 is the Overview (story map, every file, no filter), then 1..N are
 * the chapters. A story map at the top of a chapter's narrative, before its
 * "Chapter N" heading, is moved to the Overview.
 *
 * Selectors (checked against github.com 2026-10-20):
 *   /changes  file:   [role=region][id="diff-<sha256(path)>"], wrapped by a
 *                     one-child div inside [data-testid=progressive-diffs-list]
 *             line:   [data-line-anchor="diff-<sha>R<n>"] (L<n> for removed lines)
 *             viewed: header button[aria-pressed] whose text is "Viewed" (read only)
 *             tree:   [role=tree] [role=treeitem], id = file or folder path
 *   /files    file:   copilot-diff-entry[data-file-path] or .file[data-tagsearch-path]
 *             line:   #diff-<sha>R<n>
 *             viewed: input.js-reviewed-checkbox (read only)
 *             tree:   file-tree li[data-tree-entry-type] with a[href="#diff-<sha>"]
 *   fallback  file:   a header (h3, [class*=file-name], .file-info a) whose text is the path
 */
function prStoryOverlay(INPUT) {
  'use strict';
  const NS = 'prs-overlay';
  if (window.__prStoryOverlay) {
    window.__prStoryOverlay.destroy();
  }
  const DATA = JSON.parse(JSON.stringify(INPUT));

  const shaToPath = new Map(DATA.files.map((f) => [f.sha, f.rel]));
  const pathToSha = new Map(DATA.files.map((f) => [f.rel, f.sha]));
  const allPaths = new Set(DATA.files.map((f) => f.rel));
  const allRels = DATA.files.map((f) => f.rel);

  // ---------- the Overview step takes any story map off the chapters
  const CH_HEAD = /^#{1,6}\s+Chapter\s+\d+\b/m;
  let overviewMd = DATA.overview || '';
  for (const ch of DATA.chapters) {
    const text = ch.narrative || '';
    const m = CH_HEAD.exec(text);
    const pre = m ? text.slice(0, m.index) : '';
    if (pre.trim() && /story map/i.test(pre)) {
      if (!overviewMd) {
        overviewMd = pre.trim();
      }
      ch.narrative = text.slice(m.index);
    }
  }

  // ---------- where each file is finished, and what to tell the reviewer about it
  const finishedIn = {};
  DATA.chapters.forEach((ch, i) =>
    ch.files.forEach((f) => {
      if (!f.partial && finishedIn[f.rel] == null) {
        finishedIn[f.rel] = i + 1;
      }
    }),
  );
  const chaptersOf = (rel) =>
    DATA.chapters.map((c, i) => (c.files.some((f) => f.rel === rel) ? i + 1 : 0)).filter(Boolean);
  function status(rel, n) {
    const e = n && DATA.chapters[n - 1].files.find((f) => f.rel === rel);
    if (!e) {
      return null;
    }
    const fin = finishedIn[rel];
    if (fin != null && fin < n) {
      return {
        kind: 'done',
        text: `Already finished in chapter ${fin}`,
        short: `done in ch ${fin}`,
      };
    }
    if (e.partial && fin != null && fin > n) {
      return {
        kind: 'later',
        text: `Leave unviewed: comes back in chapter ${fin}${e.note ? ` (${e.note})` : ''}`,
        short: `back in ch ${fin}`,
      };
    }
    return { kind: 'mark', text: 'Mark viewed', short: 'mark viewed' };
  }

  const start = Number.isFinite(DATA.start) ? DATA.start : 0;
  const state = {
    n: Math.min(Math.max(0, start), DATA.chapters.length),
    all: false,
    collapsed: false,
    width: 460,
  };
  const chapter = () => (state.n ? DATA.chapters[state.n - 1] : null);
  const inChapter = () => new Set(state.n ? chapter().files.map((f) => f.rel) : allRels);

  // ---------- styles (Primer variables, so GitHub's light/dark theme carries over)
  const css = `
  html.${NS}-docked body { margin-right: var(--prs-w) !important; }
  [data-prs-hidden] { display: none !important; }
  [data-prs-flash] { outline: 2px solid var(--fgColor-accent, #0969da) !important; outline-offset: 2px; border-radius: 6px; }
  tr[data-prs-flash] { outline: none !important; }
  tr[data-prs-flash] > td { background-color: var(--bgColor-attention-muted, #fff8c5) !important; box-shadow: inset 0 0 0 9999px rgba(212,167,44,.12); }
  #${NS} { --c-bg: var(--bgColor-default, #fff); --c-fg: var(--fgColor-default, #1f2328); --c-muted: var(--fgColor-muted, #59636e);
    --c-border: var(--borderColor-default, #d1d9e0); --c-subtle: var(--bgColor-muted, #f6f8fa); --c-accent: var(--fgColor-accent, #0969da);
    --c-accent-bg: var(--bgColor-accent-muted, #ddf4ff); --c-ok: var(--fgColor-success, #1a7f37); --c-warn: var(--fgColor-attention, #9a6700);
    position: fixed; top: 0; right: 0; bottom: 0; width: var(--prs-w); z-index: 99; box-sizing: border-box;
    background: var(--c-bg); color: var(--c-fg); border-left: 1px solid var(--c-border);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; box-shadow: -4px 0 12px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { #${NS} { --c-bg: var(--bgColor-default, #0d1117); --c-fg: var(--fgColor-default, #f0f6fc);
    --c-muted: var(--fgColor-muted, #9198a1); --c-border: var(--borderColor-default, #3d444d); --c-subtle: var(--bgColor-muted, #151b23);
    --c-accent: var(--fgColor-accent, #4493f8); --c-accent-bg: var(--bgColor-accent-muted, #388bfd1a);
    --c-ok: var(--fgColor-success, #3fb950); --c-warn: var(--fgColor-attention, #d29922); } }
  #${NS} * { box-sizing: border-box; }
  #${NS} .prs-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; }
  #${NS} .prs-grip:hover, #${NS}.prs-dragging .prs-grip { background: var(--c-accent); opacity: .35; }
  #${NS} .prs-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--c-border); background: var(--c-subtle); }
  #${NS} .prs-bar .prs-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${NS} button { font: inherit; font-size: 12px; color: var(--c-fg); background: var(--c-bg); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #${NS} button:hover:not(:disabled) { border-color: var(--c-accent); }
  #${NS} button:disabled { opacity: .45; cursor: default; }
  #${NS} button[aria-pressed="true"] { background: var(--c-accent-bg); border-color: var(--c-accent); }
  #${NS} .prs-note { padding: 6px 12px; font-size: 12px; color: var(--c-muted); border-bottom: 1px solid var(--c-border);
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #${NS} .prs-note b { color: var(--c-fg); }
  #${NS} .prs-msg { flex-basis: 100%; color: var(--c-warn); }
  #${NS} .prs-msg:empty { display: none; }
  #${NS} .prs-body { flex: 1; overflow: auto; padding: 4px 16px 24px; }
  #${NS} h2.prs-h { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--c-muted); margin: 18px 0 6px; }
  #${NS} ol.prs-map { margin: 0; padding-left: 0; list-style: none; counter-reset: none; }
  #${NS} ol.prs-map li { padding: 1px 6px; border-radius: 4px; cursor: pointer; }
  #${NS} ol.prs-map li:hover { color: var(--c-accent); }
  #${NS} ol.prs-map li.prs-current { background: var(--c-accent-bg); font-weight: 600; color: var(--c-accent); }
  #${NS} ol.prs-map .prs-count { color: var(--c-muted); font-weight: 400; }
  #${NS} .prs-md h1, #${NS} .prs-md h2, #${NS} .prs-md h3, #${NS} .prs-md h4 { margin: 16px 0 6px; line-height: 1.3; }
  #${NS} .prs-md h1 { font-size: 18px; } #${NS} .prs-md h2 { font-size: 16px; } #${NS} .prs-md h3 { font-size: 15px; } #${NS} .prs-md h4 { font-size: 14px; }
  #${NS} .prs-md p { margin: 0 0 10px; }
  #${NS} .prs-md ul, #${NS} .prs-md ol { margin: 0 0 10px; padding-left: 22px; }
  #${NS} .prs-md li { margin: 2px 0; }
  #${NS} .prs-md li > ul, #${NS} .prs-md li > ol { margin: 2px 0 0; }
  #${NS} code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); padding: 1px 4px; border-radius: 4px; }
  #${NS} pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
  #${NS} pre code { background: none; padding: 0; }
  #${NS} blockquote { margin: 0 0 10px; padding: 0 10px; border-left: 3px solid var(--c-border); color: var(--c-muted); }
  #${NS} a { color: var(--c-accent); }
  #${NS} [data-rel] { color: var(--c-accent); cursor: pointer; }
  #${NS} [data-rel]:hover { text-decoration: underline; }
  #${NS} .prs-pill { font-size: 11px; padding: 0 5px; border-radius: 9px; border: 1px solid currentColor; margin-left: 3px; white-space: nowrap; }
  #${NS} .prs-st-mark { color: var(--c-ok); } #${NS} .prs-st-later { color: var(--c-warn); } #${NS} .prs-st-done { color: var(--c-muted); }
  #${NS} .prs-viewed { color: var(--c-ok); font-size: 12px; margin-left: 4px; white-space: nowrap; }
  #${NS} .prs-viewed:empty { display: none; }
  #${NS} .prs-comment { margin: 0 0 12px; }
  #${NS} .prs-comment .prs-where { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--c-muted); margin-bottom: 4px; }
  #${NS} ul.prs-files { list-style: none; padding: 0; margin: 0; font-size: 12px; }
  #${NS} ul.prs-files > li { padding: 4px 0; border-bottom: 1px solid var(--c-border); }
  #${NS} ul.prs-files > li:last-child { border-bottom: 0; }
  #${NS} ul.prs-files .prs-why { color: var(--c-muted); display: block; }
  #${NS} ul.prs-files .prs-missing { opacity: .6; }
  #${NS} ul.prs-lines { list-style: none; margin: 2px 0 0 12px; padding: 0; }
  #${NS} ul.prs-lines li { padding: 1px 0; }
  #${NS} .prs-empty { color: var(--c-muted); font-style: italic; }
  #${NS}.prs-collapsed .prs-note, #${NS}.prs-collapsed .prs-body, #${NS}.prs-collapsed .prs-grip, #${NS}.prs-collapsed .prs-bar > :not(.prs-toggle) { display: none; }
  #${NS}.prs-collapsed .prs-bar { flex-direction: column; height: 100%; padding: 8px 4px; border: 0; }
  #${NS}.prs-collapsed .prs-toggle { writing-mode: vertical-rl; padding: 8px 3px; }
  `;

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const unesc = (s) =>
    String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

  // ---------- file and line references
  // A backticked name is a file when it is a PR path, a path suffix such as
  // `Combobox/component.tsx`, or a basename, among the files on screen in this
  // step. An ambiguous name goes to the first match in chapter order. A
  // `path:40`, `path:40-58` or `path:L12` suffix makes it a line reference.
  let linkScope = allRels;
  let pilled = new Set();
  function resolveRef(text) {
    let t = unesc(text).trim().replace(/^\.\//, '');
    let line = null;
    const lm = /^(.*?):([LR])?(\d+)(?:-[LR]?(\d+))?$/.exec(t);
    if (lm) {
      t = lm[1];
      line = { side: lm[2] || 'R', start: +lm[3], end: +(lm[4] || lm[3]) };
    }
    if (!t || /\s/.test(t) || !/[./]/.test(t)) {
      return null;
    }
    const rel = linkScope.find((r) => r === t) || linkScope.find((r) => r.endsWith('/' + t));
    return rel ? { rel, line } : null;
  }
  function refAttrs(rel, line) {
    const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
    const a = `data-rel="${esc(rel)}" title="Scroll to ${esc(rel)}${where}"`;
    return line
      ? `${a} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"`
      : a;
  }
  /** The status pill after a file's first mention in a chapter. */
  function pill(rel) {
    if (!state.n || pilled.has(rel)) {
      return '';
    }
    pilled.add(rel);
    const st = status(rel, state.n);
    return st
      ? `<span class="prs-pill prs-st-${st.kind}" title="${esc(st.text)}">${esc(st.short)}</span>`
      : '';
  }

  // ---------- tiny markdown (escape first, then a block pass and an inline pass)
  function inline(s) {
    const codes = [];
    s = esc(s).replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, text, url) => {
        // links to this PR's files (and lines) scroll the page instead of navigating
        const hit = /#diff-([0-9a-f]{64})(?:([LR])(\d+)(?:-[LR]?(\d+))?)?$/.exec(url);
        const rel = hit && shaToPath.get(hit[1]);
        if (rel && linkScope.includes(rel)) {
          const line = hit[3] ? { side: hit[2], start: +hit[3], end: +(hit[4] || hit[3]) } : null;
          return `<span ${refAttrs(rel, line)}>${text}</span>${pill(rel)}`;
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      });
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => {
      const ref = resolveRef(codes[i]);
      return ref
        ? `<code ${refAttrs(ref.rel, ref.line)}>${codes[i]}</code>${pill(ref.rel)}`
        : `<code>${codes[i]}</code>`;
    });
  }
  function markdown(src) {
    const lines = String(src || '')
      .replace(/\r/g, '')
      .split('\n');
    let html = '';
    let para = [];
    let list = null; // stack of {type, indent}
    const flushPara = () => {
      if (para.length) {
        html += `<p>${inline(para.join(' '))}</p>`;
      }
      para = [];
    };
    const closeLists = (toIndent = -1) => {
      while (list && list.length && list[list.length - 1].indent > toIndent) {
        html += `</li></${list.pop().type}>`;
      }
      if (list && !list.length) {
        list = null;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara();
        closeLists();
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) {
          body.push(lines[i]);
        }
        html += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushPara();
        closeLists();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          body.push(lines[i++].replace(/^\s*> ?/, ''));
        }
        i--;
        html += `<blockquote>${markdown(body.join('\n'))}</blockquote>`;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        closeLists();
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      const li = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const indent = li[1].length;
        const type = /\d/.test(li[2]) ? 'ol' : 'ul';
        closeLists(indent);
        if (!list) {
          list = [];
        }
        const top = list[list.length - 1];
        if (top && top.indent === indent && top.type === type) {
          html += '</li><li>';
        } else {
          if (top && top.indent === indent) {
            html += `</li></${list.pop().type}>`;
          }
          html += `<${type}><li>`;
          list.push({ type, indent });
        }
        html += inline(li[3]);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        if (
          list &&
          !/^\s+\S/.test(lines[i + 1] || '') &&
          !/^\s*(\d+[.)]|[-*+])\s/.test(lines[i + 1] || '')
        ) {
          closeLists();
        }
        continue;
      }
      if (list) {
        html += ' ' + inline(line.trim());
        continue;
      }
      para.push(line.trim());
    }
    flushPara();
    closeLists();
    return html;
  }

  // ---------- finding files, lines and viewed state on the page (read only)
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
        add(rel, el.closest('copilot-diff-entry') || outer(el));
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
    if (!found.size) {
      for (const el of document.querySelectorAll(
        'h3, [class*="file-name"], .file-info a, .file-header [title]',
      )) {
        const text = (el.getAttribute('title') || el.textContent || '').trim().replace(/‎/g, '');
        const rel = allPaths.has(text)
          ? text
          : [...allPaths].find((p) => text.endsWith(' → ' + p) || text.endsWith(' -> ' + p));
        if (!rel) {
          continue;
        }
        const block = el.closest('[role="region"], .file, copilot-diff-entry');
        if (block) {
          add(rel, block.closest('copilot-diff-entry') || outer(block));
        }
      }
    }
    return [...found].map(([el, rel]) => ({ rel, el }));
  }
  /** Climb through one-child wrappers, so the gap GitHub leaves between files goes too. */
  function outer(el) {
    let e = el;
    for (
      let i = 0;
      i < 3 &&
      e.parentElement &&
      e.parentElement.children.length === 1 &&
      e.parentElement !== document.body;
      i++
    ) {
      e = e.parentElement;
    }
    return e;
  }
  const blockOf = (rel) => fileBlocks().find((x) => x.rel === rel);
  function lineCell(rel, side, n) {
    const id = `diff-${pathToSha.get(rel)}${side}${n}`;
    return document.querySelector(`[data-line-anchor="${id}"]`) || document.getElementById(id);
  }
  /** true/false from the file header's Viewed toggle, or null when it can't tell. Never clicks it. */
  function isViewed(rel) {
    const b = blockOf(rel);
    if (!b) {
      return null;
    }
    const btn = [...b.el.querySelectorAll('button[aria-pressed]')].find((x) =>
      /^\s*viewed\s*$/i.test(x.textContent),
    );
    if (btn) {
      return btn.getAttribute('aria-pressed') === 'true';
    }
    const cb = b.el.querySelector('input.js-reviewed-checkbox');
    return cb ? cb.checked : null;
  }

  /** File-tree rows: [{rel|dir, el}]. */
  function treeRows() {
    const rows = [];
    for (const el of document.querySelectorAll('[role="tree"] [role="treeitem"]')) {
      if (el.closest('#' + NS)) {
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
      const a = el.querySelector(
        ':scope > a[href*="#diff-"], :scope > .ActionList-content[href*="#diff-"]',
      );
      const type = el.getAttribute('data-tree-entry-type');
      if (a && type !== 'directory' && type !== 'root') {
        rows.push({ rel: shaToPath.get(a.getAttribute('href').split('#diff-')[1]), el });
      } else if (type === 'directory' || type === 'root') {
        rows.push({ dir: null, el });
      }
    }
    return rows;
  }

  // ---------- filtering
  let seen = { found: 0, shown: 0, missing: [] };
  function setHidden(el, hide) {
    if (hide && !el.hasAttribute('data-prs-hidden')) {
      el.setAttribute('data-prs-hidden', '');
    }
    if (!hide && el.hasAttribute('data-prs-hidden')) {
      el.removeAttribute('data-prs-hidden');
    }
  }
  function apply() {
    const want = inChapter();
    const showAll = state.all || state.n === 0;
    const blocks = fileBlocks();
    const onPage = new Set();
    for (const { rel, el } of blocks) {
      onPage.add(rel);
      setHidden(el, !showAll && !want.has(rel));
    }
    const rows = treeRows();
    const fileRows = rows.filter((r) => r.rel);
    for (const r of fileRows) {
      setHidden(r.el, !showAll && !want.has(r.rel));
    }
    // folders: keep one if a chapter file lives under it or any of its rows is still showing
    for (const r of rows.filter((x) => !x.rel)) {
      const under = r.dir && [...want].some((p) => p.startsWith(r.dir + '/'));
      const visibleKid = fileRows.some(
        (f) => r.el.contains(f.el) && !f.el.hasAttribute('data-prs-hidden'),
      );
      setHidden(r.el, !showAll && !under && !visibleKid);
    }
    seen = {
      found: blocks.length,
      shown: [...want].filter((p) => onPage.has(p)).length,
      missing: [...want].filter((p) => !onPage.has(p)),
    };
    renderNote();
    renderViewed();
  }
  function unhideAll() {
    for (const el of document.querySelectorAll('[data-prs-hidden], [data-prs-flash]')) {
      el.removeAttribute('data-prs-hidden');
      el.removeAttribute('data-prs-flash');
    }
  }

  // GitHub loads and re-renders diffs as you scroll, and flips aria-pressed when
  // The reviewer ticks Viewed, so re-filter and refresh the check marks after changes.
  let pending = 0;
  const observer = new MutationObserver((muts) => {
    if (muts.every((m) => panel.contains(m.target))) {
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = 0;
        apply();
      }, 150);
    }
  });

  // ---------- the panel
  const style = document.createElement('style');
  style.id = NS + '-style';
  style.textContent = css;
  const panel = document.createElement('aside');
  panel.id = NS;
  panel.setAttribute('aria-label', 'PR story');
  panel.innerHTML = `
    <div class="prs-grip" title="Drag to resize"></div>
    <div class="prs-bar">
      <button class="prs-toggle" title="Collapse or expand the story panel">Hide story</button>
      <button class="prs-prev" title="Previous step">&larr; Prev</button>
      <span class="prs-title"></span>
      <button class="prs-next" title="Next step">Next &rarr;</button>
      <button class="prs-close" title="Remove the overlay and show every file">&times;</button>
    </div>
    <div class="prs-note"><span class="prs-count-note"></span><span class="prs-msg"></span></div>
    <div class="prs-body"></div>`;
  const $ = (sel) => panel.querySelector(sel);

  let msgTimer = 0;
  function message(text) {
    clearTimeout(msgTimer);
    $('.prs-msg').textContent = text || '';
    if (text) {
      msgTimer = setTimeout(() => {
        $('.prs-msg').textContent = '';
      }, 8000);
    }
  }

  function renderNote() {
    const total = DATA.files.length;
    let html;
    if (state.n === 0) {
      html = `<span>Overview: all <b>${total}</b> files, ${DATA.chapters.length} chapters</span>`;
    } else {
      const n = chapter().files.length;
      const extra =
        seen.missing.length && !state.all
          ? ` <span title="${esc(seen.missing.join('\n'))}">(${seen.missing.length} not loaded on the page yet)</span>`
          : '';
      html = state.all
        ? `<span>Showing all <b>${total}</b> files. Chapter ${state.n}'s ${n} are listed below.</span> <button class="prs-all" aria-pressed="true">Chapter files only</button>`
        : `<span>Showing <b>${n}</b> of <b>${total}</b> files, chapter ${state.n}${extra}</span> <button class="prs-all" aria-pressed="false">Show all files</button>`;
    }
    $('.prs-count-note').innerHTML = html;
    const all = $('.prs-all');
    if (all) {
      all.onclick = () => {
        state.all = !state.all;
        apply();
      };
    }
    for (const li of panel.querySelectorAll('ul.prs-files > li[data-file]')) {
      li.classList.toggle('prs-missing', seen.missing.includes(li.getAttribute('data-file')));
    }
  }
  function renderViewed() {
    for (const el of panel.querySelectorAll('[data-viewed-for]')) {
      const v = isViewed(el.getAttribute('data-viewed-for'));
      el.textContent = v ? '✓ viewed' : '';
    }
  }

  function fileItem(f, n) {
    const st = status(f.rel, n);
    const why =
      n === 0
        ? `chapter${chaptersOf(f.rel).length > 1 ? 's' : ''} ${chaptersOf(f.rel).join(', ')}`
        : `${st ? st.text : ''}${f.partial && st && st.kind !== 'later' && f.note ? ` (here: ${f.note})` : ''}`;
    const lines = (f.lines || [])
      .map((l) => {
        const side = l.side === 'L' ? 'L' : 'R';
        const range = `${side === 'L' ? 'old ' : ''}line${l.end && l.end !== l.start ? `s ${l.start}–${l.end}` : ` ${l.start}`}`;
        return `<li><span ${refAttrs(f.rel, { side, start: l.start, end: l.end || l.start })}>${range}</span>${l.label ? ` ${esc(l.label)}` : ''}</li>`;
      })
      .join('');
    return (
      `<li data-file="${esc(f.rel)}"><code ${refAttrs(f.rel, null)}>${esc(f.rel)}</code><span class="prs-viewed" data-viewed-for="${esc(f.rel)}"></span>` +
      `${why ? `<span class="prs-why${st ? ` prs-st-${st.kind}` : ''}">${esc(why)}</span>` : ''}${lines ? `<ul class="prs-lines">${lines}</ul>` : ''}</li>`
    );
  }

  function renderBody() {
    const ch = chapter();
    const steps = [
      `<li data-n="0" class="${state.n === 0 ? 'prs-current' : ''}">Overview <span class="prs-count">(${DATA.files.length})</span></li>`,
    ]
      .concat(
        DATA.chapters.map(
          (c, i) =>
            `<li data-n="${i + 1}" class="${i + 1 === state.n ? 'prs-current' : ''}">${i + 1}. ${esc(c.title.replace(/^Chapter \d+:\s*/, ''))} <span class="prs-count">(${c.files.length})</span></li>`,
        ),
      )
      .join('');
    $('.prs-title').textContent = ch ? ch.title : `Overview: ${DATA.pr.title || ''}`;
    $('.prs-title').title = $('.prs-title').textContent;
    $('.prs-prev').disabled = state.n === 0;
    $('.prs-next').disabled = state.n === DATA.chapters.length;
    pilled = new Set();
    let body;
    if (!ch) {
      linkScope = allRels;
      const intro = overviewMd
        ? markdown(overviewMd)
        : `${DATA.summary ? `<p>${inline(DATA.summary)}</p>` : ''}${DATA.plan ? `<p>${inline(DATA.plan)}</p>` : ''}`;
      const files = DATA.files.map((f) => fileItem(f, 0)).join('');
      body = `<div class="prs-md">${intro}</div><h2 class="prs-h">All files (${DATA.files.length})</h2><ul class="prs-files">${files}</ul>`;
    } else {
      linkScope = ch.files.map((f) => f.rel);
      const story = ch.narrative
        ? markdown(ch.narrative)
        : `${ch.headline ? `<p><strong>${inline(ch.headline)}</strong></p>` : ''}${ch.scenario ? `<p>The scenario: ${inline(ch.scenario)}</p>` : ''}${ch.summary ? `<p>${inline(ch.summary)}</p>` : ''}<p class="prs-empty">This chapter's story isn't written yet.</p>`;
      const comments = (ch.comments || [])
        .map((c, i) => {
          const general = !c.line || /^\(/.test(c.path || '');
          const ref = !general && resolveRef(c.path);
          const name = ref
            ? `<code ${refAttrs(ref.rel, { side: 'R', start: c.line, end: c.line })}>${esc(c.path)}</code>`
            : `<code>${esc(c.path)}</code>`;
          const where = general ? 'General PR comment' : `On ${name} line ${c.line}`;
          return `<div class="prs-comment"><div class="prs-where"><span>${where}</span><button class="prs-copy" data-i="${i}">Copy</button></div><pre>${esc(c.body)}</pre></div>`;
        })
        .join('');
      const files = ch.files.map((f) => fileItem(f, state.n)).join('');
      body = `<div class="prs-md">${story}</div>
        ${comments ? `<h2 class="prs-h">Draft comments</h2>${comments}` : ''}
        <h2 class="prs-h">Files in this chapter (${ch.files.length})</h2><ul class="prs-files">${files}</ul>`;
    }
    $('.prs-body').innerHTML =
      `<h2 class="prs-h">Steps</h2><ol class="prs-map">${steps}</ol>${body}`;
    $('.prs-body').scrollTop = 0;
  }

  // one click handler for everything in the panel body
  $('.prs-body').addEventListener('click', (e) => {
    const step = e.target.closest('ol.prs-map li[data-n]');
    if (step) {
      return go(Number(step.getAttribute('data-n')));
    }
    const copyBtn = e.target.closest('.prs-copy');
    if (copyBtn) {
      return copy(chapter().comments[Number(copyBtn.getAttribute('data-i'))].body, copyBtn);
    }
    const ref = e.target.closest('[data-rel]');
    if (!ref) {
      return;
    }
    const rel = ref.getAttribute('data-rel');
    if (ref.hasAttribute('data-start')) {
      scrollToLine(
        rel,
        ref.getAttribute('data-side') || 'R',
        +ref.getAttribute('data-start'),
        +ref.getAttribute('data-end'),
      );
    } else {
      scrollToFile(rel);
    }
  });

  function go(n) {
    if (n < 0 || n > DATA.chapters.length) {
      return;
    }
    state.n = n;
    state.all = false;
    message('');
    renderBody();
    apply();
    if (n === 0) {
      window.scrollTo({ top: 0 });
    } else if (chapter().files[0]) {
      scrollToFile(chapter().files[0].rel, true);
    }
  }

  function flash(els) {
    for (const el of els) {
      el.setAttribute('data-prs-flash', '');
    }
    setTimeout(() => {
      for (const el of els) {
        el.removeAttribute('data-prs-flash');
      }
    }, 2500);
  }
  function scrollTo(el, frac) {
    const top =
      el.getBoundingClientRect().top + window.scrollY - (frac ? window.innerHeight * frac : 72);
    window.scrollTo({ top: Math.max(0, top) });
  }
  function scrollToFile(rel, quiet) {
    const b = blockOf(rel);
    if (!b) {
      if (!quiet) {
        message(`${rel} isn't loaded on the page yet. Scroll the diff and try again.`);
      }
      return false;
    }
    scrollTo(b.el);
    if (!quiet) {
      flash([b.el]);
    }
    return true;
  }
  /** Scroll a line range into view and highlight it. Never expands a hunk or a collapsed file. */
  function scrollToLine(rel, side, startLine, endLine) {
    let target = lineCell(rel, side, startLine);
    let note = '';
    if (!target) {
      // nearest line GitHub has rendered for this file and side
      const prefix = `diff-${pathToSha.get(rel)}${side}`;
      const near = [...document.querySelectorAll(`[data-line-anchor^="${prefix}"]`)]
        .map((c) => ({ c, n: +c.getAttribute('data-line-anchor').slice(prefix.length) }))
        .filter((x) => x.n > 0)
        .sort((a, b) => Math.abs(a.n - startLine) - Math.abs(b.n - startLine))[0];
      if (near) {
        target = near.c;
        note = `Line ${startLine} isn't in the diff GitHub shows, so this is the nearest line, ${near.n}. GitHub's expand arrows above it show more.`;
      }
    }
    if (!target) {
      scrollToFile(rel, true);
      message(
        `Line ${startLine} of ${rel.split('/').pop()} isn't on the page. The file may be collapsed (Viewed files collapse) or not loaded. Expand it in GitHub, then click again.`,
      );
      return false;
    }
    const rowOf = (c) => c.closest('tr') || c;
    scrollTo(rowOf(target), 0.25);
    const rows = [];
    for (
      let n = startLine;
      n <= Math.max(startLine, endLine || startLine) && n < startLine + 400;
      n++
    ) {
      const c = lineCell(rel, side, n);
      if (c && !rows.includes(rowOf(c))) {
        rows.push(rowOf(c));
      }
    }
    flash(rows.length ? rows : [rowOf(target)]);
    message(note);
    return true;
  }

  function copy(text, btn) {
    const done = (ok) => {
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1500);
    };
    const fallback = () => {
      const pre = btn.closest('.prs-comment').querySelector('pre');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), fallback);
    } else {
      fallback();
    }
  }

  function setWidth(w) {
    state.width = Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.7));
    document.documentElement.style.setProperty(
      '--prs-w',
      (state.collapsed ? 36 : state.width) + 'px',
    );
  }
  function setCollapsed(c) {
    state.collapsed = c;
    panel.classList.toggle('prs-collapsed', c);
    $('.prs-toggle').textContent = c ? 'Show story' : 'Hide story';
    setWidth(state.width);
  }

  // resize by dragging the left edge
  $('.prs-grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    panel.classList.add('prs-dragging');
    const move = (ev) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      panel.classList.remove('prs-dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  $('.prs-toggle').onclick = () => setCollapsed(!state.collapsed);
  $('.prs-prev').onclick = () => go(state.n - 1);
  $('.prs-next').onclick = () => go(state.n + 1);
  $('.prs-close').onclick = () => destroy();
  const onResize = () => setWidth(state.width);
  window.addEventListener('resize', onResize);

  function destroy() {
    observer.disconnect();
    clearTimeout(pending);
    clearTimeout(msgTimer);
    window.removeEventListener('resize', onResize);
    unhideAll();
    panel.remove();
    style.remove();
    document.documentElement.classList.remove(NS + '-docked');
    document.documentElement.style.removeProperty('--prs-w');
    delete window.__prStoryOverlay;
  }

  document.head.appendChild(style);
  document.body.appendChild(panel);
  document.documentElement.classList.add(NS + '-docked');
  setWidth(Math.min(state.width, Math.round(window.innerWidth * 0.4)));
  renderBody();
  apply();
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });

  window.__prStoryOverlay = {
    destroy,
    go,
    apply,
    scrollToLine,
    scrollToFile,
    state,
    data: INPUT,
    get seen() {
      return seen;
    },
  };
  const label = state.n
    ? `chapter ${state.n} of ${DATA.chapters.length}`
    : `overview (${DATA.chapters.length} chapters)`;
  return `pr-story overlay: ${label}, ${seen.shown} of ${inChapter().size} files found on the page (${seen.found} file blocks seen, ${DATA.files.length} in the PR)`;
}
