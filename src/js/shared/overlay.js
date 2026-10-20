/*
 * Diff Story Mode panel. Ported from the pr-story GitHub overlay
 * (~/.claude/skills/pr-story/bin/overlay.js), and loaded two ways:
 *   - by the extension's content script on a GitHub PR's /changes or /files page
 *   - by the bridge's local page (bridge/public/local.js), whose diff view uses
 *     the same DOM shapes as GitHub's /changes page
 *
 * It adds a side panel, hides other chapters' files with display:none and
 * scrolls the page. It never clicks the host page's controls (Viewed, expand,
 * comment, review, approve), never submits the host page's forms and makes no
 * network calls itself. Saving the step, reporting position and sending
 * questions all go through callbacks the caller passes in `opts`, and the
 * caller decides where they go (the extension sends them to the bridge
 * through its service worker).
 *
 * Steps: 0 is the Overview (story map, every file, no filter), then 1..N are
 * the chapters. A story map at the top of a chapter's narrative, before its
 * "Chapter N" heading, is moved to the Overview.
 *
 * Backstory (optional, from the Claude Code sessions that made the change):
 * the result story always leads. A chapter's backstory is a collapsed
 * "Backstory" section under its narrative, a file row gets a small "why" link
 * that opens its "How it got here", and the Overview has the summary. A
 * secondary "Backstory view" switches the whole panel to the chronological
 * telling (one step per moment of work, diff filtered to its files). The
 * journey story is the default; the view is remembered only once switched.
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
 *
 * opts (all optional):
 *   initial        {n, all, collapsed, width, view, bn} to start from (a saved step; bn is the backstory view's step)
 *   onState(s)     called with {n, all, collapsed, width, view, bn} whenever they change
 *   onPosition(p)  called with {step, chapter, file} when the step or the file at the top of the screen changes (debounced)
 *   onClose()      called after the x button removes the panel
 *   ask(q)         send a question {text, step, chapter, file}; returns a Promise
 *   loadQuestions() returns a Promise of [{id, at, step, text, file, answers: [{at, text}]}]
 *   status()       returns a Promise of the bridge's /api/status ({bridge, story, listening, autoBuild, autoAnswer});
 *                  it rejects with err.code 'down', 'token' or 'old' when the bridge can't say. Drives the status light.
 *   host           name of the page that owns the diff, for messages ("GitHub")
 *   commentsTitle  heading for the chapter's drafted comments ("Draft comments")
 */
export function storyOverlay(INPUT, opts = {}) {
  const HOST_ID = 'diff-story-panel'; // the element on the page; the panel itself lives in its shadow root
  const NS = 'dsm-panel';
  if (window.__diffStoryOverlay) window.__diffStoryOverlay.destroy();
  const DATA = JSON.parse(JSON.stringify(INPUT));
  const HOST = opts.host || 'GitHub';
  const COMMENTS_TITLE = opts.commentsTitle || 'Draft comments';

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
      if (!overviewMd) overviewMd = pre.trim();
      ch.narrative = text.slice(m.index);
    }
  }

  // ---------- where each file is finished, and what to tell Eric about it
  const finishedIn = {};
  DATA.chapters.forEach((ch, i) => ch.files.forEach((f) => { if (!f.partial && finishedIn[f.rel] == null) finishedIn[f.rel] = i + 1; }));
  const chaptersOf = (rel) => DATA.chapters.map((c, i) => (c.files.some((f) => f.rel === rel) ? i + 1 : 0)).filter(Boolean);
  function status(rel, n) {
    if (inBackstory()) return null;
    const e = n && DATA.chapters[n - 1].files.find((f) => f.rel === rel);
    if (!e) return null;
    const fin = finishedIn[rel];
    if (fin != null && fin < n) return { kind: 'done', text: `Already finished in chapter ${fin}`, short: `done in ch ${fin}` };
    if (e.partial && fin != null && fin > n) return { kind: 'later', text: `Leave unviewed: comes back in chapter ${fin}${e.note ? ` (${e.note})` : ''}`, short: `back in ch ${fin}` };
    return { kind: 'mark', text: 'Mark viewed', short: 'mark viewed' };
  }

  // ---------- backstory: the chronological view's steps, one per moment of work
  const BS = DATA.backstory && typeof DATA.backstory === 'object' ? DATA.backstory : null;
  const TIMELINE = BS && Array.isArray(BS.timeline) ? BS.timeline.filter((t) => t && (t.title || t.text)) : [];
  const BS_CH = TIMELINE.map((t, i) => ({
    title: `${i + 1}. ${t.title || 'Work'}`,
    narrative: '',
    entry: t,
    files: (t.files || []).filter((rel) => allPaths.has(rel)).map((rel) => {
      const rs = (t.lines && t.lines[rel]) || [];
      const e = { rel, partial: false, note: null };
      if (rs.length) e.lines = rs.slice(0, 4).map(([a, b]) => ({ side: 'R', start: a, end: b || a, label: 'changed here' }));
      return e;
    }),
    comments: [],
  }));

  const init = opts.initial || {};
  const startView = init.view === 'backstory' && BS_CH.length ? 'backstory' : 'story';
  const storyStart = Number.isFinite(init.n) ? init.n : Number.isFinite(DATA.start) ? DATA.start : 0;
  const bsStart = Number.isFinite(init.bn) ? init.bn : 0;
  const clampN = (n, view) => Math.min(Math.max(0, n), (view === 'backstory' ? BS_CH : DATA.chapters).length);
  const state = {
    view: startView,
    n: clampN(startView === 'backstory' ? bsStart : storyStart, startView), // the step in the view on screen
    other: clampN(startView === 'backstory' ? storyStart : bsStart, startView === 'backstory' ? 'story' : 'backstory'), // the step kept for the other view
    all: !!init.all,
    collapsed: !!init.collapsed,
    width: Number.isFinite(init.width) ? init.width : 460,
    filesOpen: !!init.filesOpen, // the "Files in this chapter" list starts folded
  };
  const inBackstory = () => state.view === 'backstory';
  const steps = () => (inBackstory() ? BS_CH : DATA.chapters);
  const saveState = () => {
    if (!opts.onState) return;
    const sn = inBackstory() ? state.other : state.n;
    const bn = inBackstory() ? state.n : state.other;
    opts.onState({ n: sn, bn, view: state.view, all: state.all, collapsed: state.collapsed, width: state.width, filesOpen: state.filesOpen });
  };
  const chapter = () => (state.n ? steps()[state.n - 1] : null);
  const inChapter = () => new Set(state.n ? chapter().files.map((f) => f.rel) : allRels);

  // ---------- styles (Primer variables, so GitHub's light/dark theme carries over)
  // The page gets only these few rules, all keyed to our own attributes and class.
  const docCss = `
  html.${HOST_ID}-docked body { margin-right: var(--dsm-w) !important; }
  #${HOST_ID} { all: initial; }
  [data-dsm-hidden] { display: none !important; }
  [data-dsm-flash] { outline: 2px solid var(--fgColor-accent, #0969da) !important; outline-offset: 2px; border-radius: 6px; }
  tr[data-dsm-flash] { outline: none !important; }
  tr[data-dsm-flash] > td { background-color: var(--bgColor-attention-muted, #fff8c5) !important; box-shadow: inset 0 0 0 9999px rgba(212,167,44,.12); }
  `;
  // Everything else is inside the panel's shadow root, so the page's CSS (and other extensions') can't reach it, nor it them.
  const css = `
  :host { all: initial; }
  #${NS}:focus { outline: none; }
  #${NS} { --c-bg: var(--bgColor-default, #fff); --c-fg: var(--fgColor-default, #1f2328); --c-muted: var(--fgColor-muted, #59636e);
    --c-border: var(--borderColor-default, #d1d9e0); --c-subtle: var(--bgColor-muted, #f6f8fa); --c-accent: var(--fgColor-accent, #0969da);
    --c-accent-bg: var(--bgColor-accent-muted, #ddf4ff); --c-ok: var(--fgColor-success, #1a7f37); --c-warn: var(--fgColor-attention, #9a6700); --c-err: var(--fgColor-danger, #d1242f);
    position: fixed; top: 0; right: 0; bottom: 0; width: var(--dsm-w); z-index: 99; box-sizing: border-box;
    background: var(--c-bg); color: var(--c-fg); border-left: 1px solid var(--c-border);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; box-shadow: -4px 0 12px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { #${NS} { --c-bg: var(--bgColor-default, #0d1117); --c-fg: var(--fgColor-default, #f0f6fc);
    --c-muted: var(--fgColor-muted, #9198a1); --c-border: var(--borderColor-default, #3d444d); --c-subtle: var(--bgColor-muted, #151b23);
    --c-accent: var(--fgColor-accent, #4493f8); --c-accent-bg: var(--bgColor-accent-muted, #388bfd1a);
    --c-ok: var(--fgColor-success, #3fb950); --c-warn: var(--fgColor-attention, #d29922); --c-err: var(--fgColor-danger, #f85149); } }
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
  #${NS} .prs-progress { flex-basis: 100%; }
  #${NS} button.prs-light { border: 0; background: none; padding: 2px 4px; }
  #${NS} .prs-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--c-muted); vertical-align: middle; }
  #${NS} .prs-light[data-level="ok"] .prs-dot { background: var(--c-ok); }
  #${NS} .prs-light[data-level="warn"] .prs-dot { background: var(--c-warn); }
  #${NS} .prs-light[data-level="error"] .prs-dot { background: var(--c-err); }
  #${NS} .prs-health { flex-basis: 100%; margin: 2px 0; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-bg); }
  #${NS} .prs-health ul { list-style: none; margin: 0; padding: 0; }
  #${NS} .prs-health li { padding: 1px 0; }
  #${NS} .prs-health .prs-hok { color: var(--c-ok); } #${NS} .prs-health .prs-hwarn { color: var(--c-warn); } #${NS} .prs-health .prs-herr { color: var(--c-err); }
  #${NS} .prs-askhint { padding: 6px 10px 0; font-size: 12px; color: var(--c-warn); background: var(--c-subtle); border-top: 1px solid var(--c-border); }
  #${NS} .prs-askhint code { font-size: 11px; }
  #${NS} .prs-progress:empty { display: none; }
  #${NS} .prs-progress .prs-done { color: var(--c-ok); font-weight: 600; }
  #${NS} .prs-progress b { color: var(--c-fg); }
  #${NS} .prs-stepprog { font-size: 11px; color: var(--c-muted); margin-left: 4px; }
  #${NS} .prs-stepprog.prs-done { color: var(--c-ok); }
  #${NS} details.prs-filesbox > summary { cursor: pointer; list-style: none; margin: 18px 0 6px; }
  #${NS} details.prs-filesbox > summary::-webkit-details-marker { display: none; }
  #${NS} details.prs-filesbox > summary .prs-h { display: inline; margin: 0; }
  #${NS} details.prs-filesbox > summary::before { content: "▸ "; color: var(--c-muted); font-size: 11px; }
  #${NS} details.prs-filesbox[open] > summary::before { content: "▾ "; }
  #${NS} details.prs-filesbox > summary .prs-sum { font-size: 12px; color: var(--c-muted); margin-left: 6px; }
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
  #${NS} .prs-qa { margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 6px; }
  #${NS} .prs-qa .prs-q { font-weight: 600; white-space: pre-wrap; }
  #${NS} .prs-qa .prs-qmeta { font-size: 11px; color: var(--c-muted); }
  #${NS} .prs-qa .prs-a { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--c-border); }
  #${NS} .prs-qa .prs-wait { margin-top: 4px; font-size: 12px; color: var(--c-muted); font-style: italic; }
  #${NS} details.prs-backstory { margin: 14px 0 10px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-subtle); }
  #${NS} details.prs-backstory > summary { cursor: pointer; padding: 5px 10px; font-size: 12px; font-weight: 600; color: var(--c-muted); list-style: none; }
  #${NS} details.prs-backstory > summary::-webkit-details-marker { display: none; }
  #${NS} details.prs-backstory > summary::before { content: '▸ '; }
  #${NS} details.prs-backstory[open] > summary::before { content: '▾ '; }
  #${NS} details.prs-backstory > summary .prs-sub { font-weight: 400; }
  #${NS} details.prs-backstory > .prs-bs-body { padding: 0 10px 8px; font-size: 13px; }
  #${NS} ol.prs-bs-steps { list-style: none; margin: 4px 0 0; padding: 0; }
  #${NS} ol.prs-bs-steps > li { padding: 3px 0; border-top: 1px dashed var(--c-border); }
  #${NS} ol.prs-bs-steps > li:first-child { border-top: 0; }
  #${NS} .prs-bs-at { color: var(--c-muted); font-size: 11px; margin-right: 4px; white-space: nowrap; }
  #${NS} button.prs-sess { font-size: 11px; padding: 0 5px; border-radius: 9px; color: var(--c-muted); background: transparent; margin-left: 2px; }
  #${NS} button.prs-linkish { border: 0; background: none; padding: 0 2px; color: var(--c-muted); font-size: 11px; text-decoration: underline dotted; }
  #${NS} button.prs-linkish:hover { color: var(--c-accent); }
  #${NS} .prs-whybox { margin: 4px 0 2px 12px; padding: 6px 8px; border-left: 2px solid var(--c-border); font-size: 12px; }
  #${NS} .prs-whybox p { margin: 0 0 4px; }
  #${NS} .prs-view { margin-left: auto; }
  #${NS} .prs-bs-banner { margin: 10px 0 0; padding: 6px 10px; border-radius: 6px; background: var(--c-subtle); color: var(--c-muted); font-size: 12px; }
  #${NS} .prs-bs-banner button { font-size: 12px; }
  #${NS} blockquote.prs-asked { margin: 4px 0 8px; font-style: italic; }
  #${NS} .prs-ask { border-top: 1px solid var(--c-border); padding: 8px 10px; display: flex; gap: 6px; align-items: flex-end; background: var(--c-subtle); }
  #${NS} .prs-ask textarea { flex: 1; min-height: 34px; max-height: 160px; resize: vertical; font: inherit; font-size: 13px; color: var(--c-fg);
    background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; padding: 5px 8px; }
  #${NS} .prs-ask.prs-off { display: none; }
  #${NS}.prs-collapsed .prs-ask, #${NS}.prs-collapsed .prs-note, #${NS}.prs-collapsed .prs-body, #${NS}.prs-collapsed .prs-grip, #${NS}.prs-collapsed .prs-bar > :not(.prs-toggle) { display: none; }
  #${NS}.prs-collapsed .prs-bar { flex-direction: column; height: 100%; padding: 8px 4px; border: 0; }
  #${NS}.prs-collapsed .prs-toggle { writing-mode: vertical-rl; padding: 8px 3px; }
  `;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

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
    if (lm) { t = lm[1]; line = { side: lm[2] || 'R', start: +lm[3], end: +(lm[4] || lm[3]) }; }
    if (!t || /\s/.test(t) || !/[./]/.test(t)) return null;
    const rel = linkScope.find((r) => r === t) || linkScope.find((r) => r.endsWith('/' + t));
    return rel ? { rel, line } : null;
  }
  function refAttrs(rel, line) {
    const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
    const a = `data-rel="${esc(rel)}" title="Scroll to ${esc(rel)}${where}"`;
    return line ? `${a} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"` : a;
  }
  /** The status pill after a file's first mention in a chapter. */
  function pill(rel) {
    if (!state.n || pilled.has(rel)) return '';
    pilled.add(rel);
    const st = status(rel, state.n);
    return st ? `<span class="prs-pill prs-st-${st.kind}" title="${esc(st.text)}">${esc(st.short)}</span>` : '';
  }

  // ---------- tiny markdown (escape first, then a block pass and an inline pass)
  function inline(s) {
    const codes = [];
    s = esc(s).replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
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
      return ref ? `<code ${refAttrs(ref.rel, ref.line)}>${codes[i]}</code>${pill(ref.rel)}` : `<code>${codes[i]}</code>`;
    });
  }
  function markdown(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let html = '';
    let para = [];
    let list = null; // stack of {type, indent}
    const flushPara = () => { if (para.length) html += `<p>${inline(para.join(' '))}</p>`; para = []; };
    const closeLists = (toIndent = -1) => {
      while (list && list.length && list[list.length - 1].indent > toIndent) html += `</li></${list.pop().type}>`;
      if (list && !list.length) list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara(); closeLists();
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        html += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushPara(); closeLists();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
        i--;
        html += `<blockquote>${markdown(body.join('\n'))}</blockquote>`;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeLists(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      const li = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const indent = li[1].length;
        const type = /\d/.test(li[2]) ? 'ol' : 'ul';
        closeLists(indent);
        if (!list) list = [];
        const top = list[list.length - 1];
        if (top && top.indent === indent && top.type === type) html += '</li><li>';
        else {
          if (top && top.indent === indent) html += `</li></${list.pop().type}>`;
          html += `<${type}><li>`;
          list.push({ type, indent });
        }
        html += inline(li[3]);
        continue;
      }
      if (!line.trim()) { flushPara(); if (list && !/^\s+\S/.test(lines[i + 1] || '') && !/^\s*(\d+[.)]|[-*+])\s/.test(lines[i + 1] || '')) closeLists(); continue; }
      if (list) { html += ' ' + inline(line.trim()); continue; }
      para.push(line.trim());
    }
    flushPara(); closeLists();
    return html;
  }

  // ---------- backstory pieces
  const fmtAt = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  };
  const sessions = new Map(((BS && BS.sessions) || []).map((x) => [x.id, x]));
  /** "session d5c52a31 · turn 7 · agent": copies the resume command when clicked. */
  function sessionRef(x) {
    if (!x || !x.session) return '';
    const sid = String(x.session);
    const label = [`session ${sid.slice(0, 8)}`, x.turn != null ? `turn ${x.turn}` : '', x.agent ? String(x.agent) : ''].filter(Boolean).join(' · ');
    const full = (sessions.get(sid) || {}).id || sid;
    return `<button class="prs-sess" data-copy-text="${esc(`claude --resume ${full}`)}" title="${esc(`Claude Code session ${full}${x.turn != null ? `, turn ${x.turn}` : ''}. Click to copy the resume command.`)}">${esc(label)}</button>`;
  }
  function stepsHtml(list) {
    const items = (list || []).filter((x) => x && x.text);
    if (!items.length) return '';
    return `<ol class="prs-bs-steps">${items.map((x) => `<li>${x.at ? `<span class="prs-bs-at">${esc(fmtAt(x.at))}</span>` : ''}${inline(x.text)} ${sessionRef(x)}</li>`).join('')}</ol>`;
  }
  /** A collapsed "Backstory" section: a short summary, then dated steps. */
  function backstoryBlock(b, extra = '') {
    if (!b || (!b.summary && !(b.steps || []).length && !extra)) return '';
    return `<details class="prs-backstory"><summary>Backstory <span class="prs-sub">· how it got here</span></summary><div class="prs-bs-body">`
      + `${b.summary ? `<div class="prs-md">${markdown(b.summary)}</div>` : ''}${stepsHtml(b.steps)}${extra}</div></details>`;
  }
  /** A file's "How it got here": its own note, else the backstory moments that touched it. */
  function fileBackstory(f) {
    const own = f.backstory && (f.backstory.text || (f.backstory.steps || []).length) ? f.backstory : null;
    const lineNotes = (f.lines || []).filter((l) => l.backstory).map((l) => ({ text: `${l.side === 'L' ? 'old ' : ''}line${l.end !== l.start ? `s ${l.start}–${l.end}` : ` ${l.start}`}: ${l.backstory}` }));
    // with its own note, the moments that touched the file only name themselves; without one, each says what it did
    const moments = TIMELINE.filter((t) => (t.files || []).includes(f.rel))
      .map((t) => ({ at: t.at, text: `**${t.title}**${t.text && !own ? `: ${firstSentence(t.text)}` : ''}`, session: t.session, turn: t.turn, agent: t.agent }));
    if (!own && !lineNotes.length && !moments.length) return '';
    const steps = own && (own.steps || []).length ? own.steps : moments;
    return `${own && own.text ? `<p>${inline(own.text)}</p>` : ''}${lineNotes.map((l) => `<p>${inline(l.text)}</p>`).join('')}${stepsHtml(steps)}`;
  }
  const firstSentence = (t) => { const m = /^[\s\S]*?[.!?](\s|$)/.exec(String(t).replace(/\n+/g, ' ')); return (m ? m[0] : String(t)).trim().slice(0, 240); };
  /** The backstory view's text for one moment. */
  function momentHtml(ch) {
    const t = ch.entry;
    return `<h3>${esc(ch.title)}</h3><p>${t.at ? `<span class="prs-bs-at">${esc(fmtAt(t.at))}</span>` : ''}${sessionRef(t)}</p>`
      + `${t.asked ? `<blockquote class="prs-asked">${inline(t.asked)}</blockquote>` : ''}${t.text ? markdown(t.text) : ''}`;
  }

  // ---------- finding files, lines and viewed state on the page (read only)
  /** The page's file blocks: [{rel, el}], el being what gets hidden. */
  function fileBlocks() {
    const found = new Map();
    const add = (rel, el) => { if (rel && el && allPaths.has(rel) && !found.has(el)) found.set(el, rel); };
    for (const el of document.querySelectorAll('[id^="diff-"]')) {
      const rel = shaToPath.get(el.id.slice(5));
      if (rel) add(rel, el.closest('copilot-diff-entry') || outer(el));
    }
    for (const el of document.querySelectorAll('copilot-diff-entry[data-file-path], .file[data-tagsearch-path], .js-file[data-tagsearch-path]')) {
      add(el.getAttribute('data-file-path') || el.getAttribute('data-tagsearch-path'), el.closest('copilot-diff-entry') || el);
    }
    if (!found.size) {
      for (const el of document.querySelectorAll('h3, [class*="file-name"], .file-info a, .file-header [title]')) {
        const text = (el.getAttribute('title') || el.textContent || '').trim().replace(/‎/g, '');
        const rel = allPaths.has(text) ? text : [...allPaths].find((p) => text.endsWith(' → ' + p) || text.endsWith(' -> ' + p));
        if (!rel) continue;
        const block = el.closest('[role="region"], .file, copilot-diff-entry');
        if (block) add(rel, block.closest('copilot-diff-entry') || outer(block));
      }
    }
    return [...found].map(([el, rel]) => ({ rel, el }));
  }
  /** Climb through one-child wrappers, so the gap GitHub leaves between files goes too. */
  function outer(el) {
    let e = el;
    for (let i = 0; i < 3 && e.parentElement && e.parentElement.children.length === 1 && e.parentElement !== document.body; i++) e = e.parentElement;
    return e;
  }
  const blockOf = (rel) => fileBlocks().find((x) => x.rel === rel);
  function lineCell(rel, side, n) {
    const id = `diff-${pathToSha.get(rel)}${side}${n}`;
    return document.querySelector(`[data-line-anchor="${id}"]`) || document.getElementById(id);
  }
  /** true/false from the file header's Viewed toggle, or null when it can't tell. Never clicks it. */
  function isViewed(rel, blocks) {
    const b = blocks ? blocks.get(rel) : blockOf(rel);
    if (!b) return null;
    const btn = [...b.el.querySelectorAll('button[aria-pressed]')].find((x) => /^\s*viewed\s*$/i.test(x.textContent));
    if (btn) return btn.getAttribute('aria-pressed') === 'true';
    const cb = b.el.querySelector('input.js-reviewed-checkbox');
    return cb ? cb.checked : 'none'; // the file is on the page but has no Viewed toggle (logged out, say)
  }

  /** File-tree rows: [{rel|dir, el}]. */
  function treeRows() {
    const rows = [];
    for (const el of document.querySelectorAll('[role="tree"] [role="treeitem"]')) {
      if (el.closest('#' + NS)) continue;
      const id = el.id || '';
      if (allPaths.has(id)) rows.push({ rel: id, el });
      else if (el.hasAttribute('aria-expanded')) rows.push({ dir: id, el });
    }
    for (const el of document.querySelectorAll('file-tree li[data-tree-entry-type], .js-tree-node')) {
      const a = el.querySelector(':scope > a[href*="#diff-"], :scope > .ActionList-content[href*="#diff-"]');
      const type = el.getAttribute('data-tree-entry-type');
      if (a && type !== 'directory' && type !== 'root') rows.push({ rel: shaToPath.get(a.getAttribute('href').split('#diff-')[1]), el });
      else if (type === 'directory' || type === 'root') rows.push({ dir: null, el });
    }
    return rows;
  }

  // ---------- filtering
  let seen = { found: 0, shown: 0, missing: [] };
  function setHidden(el, hide) {
    if (hide && !el.hasAttribute('data-dsm-hidden')) el.setAttribute('data-dsm-hidden', '');
    if (!hide && el.hasAttribute('data-dsm-hidden')) el.removeAttribute('data-dsm-hidden');
  }
  /**
   * A file outside the chapter also gets the standard `hidden` attribute on
   * its block and on the elements other tools look for (Refined GitHub's
   * alt-click "mark all viewed" skips only `[class*=diffTargetable]:not([hidden])`).
   * We only ever remove a `hidden` we added (data-dsm-hid marks it).
   */
  const TARGETS = '[role="region"][id^="diff-"], [class*="diffTargetable"], .js-file, copilot-diff-entry';
  function hideBlock(el, hide) {
    setHidden(el, hide);
    const els = [el, ...el.querySelectorAll(TARGETS)].filter((x, i) => i === 0 || x.matches(TARGETS));
    for (const x of els) {
      if (hide && !x.hasAttribute('hidden')) { x.setAttribute('hidden', ''); x.setAttribute('data-dsm-hid', ''); }
      if (!hide && x.hasAttribute('data-dsm-hid')) { x.removeAttribute('hidden'); x.removeAttribute('data-dsm-hid'); }
    }
  }
  function apply() {
    const want = inChapter();
    const showAll = state.all || state.n === 0;
    const blocks = fileBlocks();
    const onPage = new Set();
    for (const { rel, el } of blocks) { onPage.add(rel); hideBlock(el, !showAll && !want.has(rel)); }
    const rows = treeRows();
    const fileRows = rows.filter((r) => r.rel);
    for (const r of fileRows) setHidden(r.el, !showAll && !want.has(r.rel));
    // folders: keep one if a chapter file lives under it or any of its rows is still showing
    for (const r of rows.filter((x) => !x.rel)) {
      const under = r.dir && [...want].some((p) => p.startsWith(r.dir + '/'));
      const visibleKid = fileRows.some((f) => r.el.contains(f.el) && !f.el.hasAttribute('data-dsm-hidden'));
      setHidden(r.el, !showAll && !under && !visibleKid);
    }
    seen = { found: blocks.length, shown: [...want].filter((p) => onPage.has(p)).length, missing: [...want].filter((p) => !onPage.has(p)) };
    renderNote();
    renderViewed();
  }
  function unhideAll() {
    for (const el of document.querySelectorAll('[data-dsm-hidden], [data-dsm-flash]')) { el.removeAttribute('data-dsm-hidden'); el.removeAttribute('data-dsm-flash'); }
    for (const el of document.querySelectorAll('[data-dsm-hid]')) { el.removeAttribute('hidden'); el.removeAttribute('data-dsm-hid'); }
  }

  // GitHub loads and re-renders diffs as you scroll, and flips aria-pressed when
  // Eric ticks Viewed, so re-filter and refresh the check marks after changes.
  let pending = 0;
  // Changes inside a diff line (Refined GitHub's show-whitespace and linkify-code wrap text in spans as you scroll) can't add or remove a file, so they don't count.
  const insideLine = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return !!(e && e.closest('td, .diff-text-inner, .blob-code-inner')); };
  const observer = new MutationObserver((muts) => {
    if (muts.every((m) => m.target === host || host.contains(m.target) || (m.type === 'childList' && insideLine(m.target)))) return;
    if (!pending) pending = setTimeout(() => { pending = 0; apply(); }, 150);
  });

  // ---------- the panel
  const style = document.createElement('style');
  style.id = HOST_ID + '-style';
  style.textContent = docCss;
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const panelStyle = document.createElement('style');
  panelStyle.textContent = css;
  shadow.appendChild(panelStyle);
  const panel = document.createElement('aside');
  panel.id = NS;
  // focusable, so a click anywhere in the panel moves focus off the page and the page's single-key shortcuts (GitHub's, Refined GitHub's j/k/x) don't fire while you read
  panel.tabIndex = -1;
  panel.setAttribute('aria-label', 'Diff story');
  panel.innerHTML = `
    <div class="prs-grip" title="Drag to resize"></div>
    <div class="prs-bar">
      <button class="prs-light" title="Checking the connection…" aria-label="Connection status" aria-expanded="false"><span class="prs-dot"></span></button>
      <button class="prs-toggle" title="Collapse or expand the story panel">Hide story</button>
      <button class="prs-prev" title="Previous step">&larr; Prev</button>
      <span class="prs-title"></span>
      <button class="prs-next" title="Next step">Next &rarr;</button>
      <button class="prs-close" title="Remove the overlay and show every file">&times;</button>
    </div>
    <div class="prs-note"><span class="prs-count-note"></span><div class="prs-health" hidden></div><div class="prs-progress" aria-live="polite"></div><span class="prs-msg"></span></div>
    <div class="prs-body"></div>
    <div class="prs-askhint" hidden></div>
    <form class="prs-ask${opts.ask ? '' : ' prs-off'}">
      <textarea placeholder="Ask about this step (Cmd+Enter sends it to the bridge inbox)" rows="1" aria-label="Question"></textarea>
      <button type="submit">Ask</button>
    </form>`;
  const $ = (sel) => panel.querySelector(sel);

  let msgTimer = 0;
  function message(text) {
    clearTimeout(msgTimer);
    $('.prs-msg').textContent = text || '';
    if (text) msgTimer = setTimeout(() => { $('.prs-msg').textContent = ''; }, 8000);
  }

  function renderNote() {
    const total = DATA.files.length;
    let html;
    const unit = inBackstory() ? 'step' : 'chapter';
    if (state.n === 0) {
      html = inBackstory()
        ? `<span>Backstory: all <b>${total}</b> files, ${BS_CH.length} step${BS_CH.length === 1 ? '' : 's'}</span>`
        : `<span>Overview: all <b>${total}</b> files, ${DATA.chapters.length} chapters</span>`;
    } else {
      const n = chapter().files.length;
      const extra = seen.missing.length && !state.all ? ` <span title="${esc(seen.missing.join('\n'))}">(${seen.missing.length} not loaded on the page yet)</span>` : '';
      html = state.all
        ? `<span>Showing all <b>${total}</b> files. ${unit[0].toUpperCase() + unit.slice(1)} ${state.n}'s ${n} are listed below.</span> <button class="prs-all" aria-pressed="true">${unit[0].toUpperCase() + unit.slice(1)} files only</button>`
        : `<span>Showing <b>${n}</b> of <b>${total}</b> files, ${unit} ${state.n}${extra}</span> <button class="prs-all" aria-pressed="false">Show all files</button>`;
    }
    // the backstory view is secondary: a small link, not a button of equal weight
    if (BS_CH.length) html += inBackstory()
      ? ' <button class="prs-linkish prs-view" data-view="story" title="Back to the story of the result">Back to the story</button>'
      : ' <button class="prs-linkish prs-view" data-view="backstory" title="Switch the panel to how it got here, step by step from the Claude Code sessions">Backstory view</button>';
    $('.prs-count-note').innerHTML = html;
    const viewBtn = $('.prs-count-note .prs-view');
    if (viewBtn) viewBtn.onclick = () => setView(viewBtn.getAttribute('data-view'));
    const all = $('.prs-all');
    if (all) all.onclick = () => { state.all = !state.all; saveState(); apply(); };
    for (const li of panel.querySelectorAll('ul.prs-files > li[data-file]')) li.classList.toggle('prs-missing', seen.missing.includes(li.getAttribute('data-file')));
  }
  // ---------- viewed progress: which of a chapter's "Mark viewed" files are ticked
  // Read from the page's own Viewed toggle (GitHub's, or the local page's), never clicked.
  // Files that come back in a later chapter, or were finished in an earlier one, don't count.
  function progressOf(n, blocks) {
    const due = DATA.chapters[n - 1].files.filter((f) => { const st = status(f.rel, n); return st && st.kind === 'mark'; }).map((f) => f.rel);
    const marks = due.map((rel) => ({ rel, v: isViewed(rel, blocks) }));
    return {
      due: due.length, viewed: marks.filter((x) => x.v === true).length, unviewed: marks.filter((x) => x.v === false).map((x) => x.rel),
      unknown: marks.filter((x) => x.v == null).map((x) => x.rel), noToggle: marks.length > 0 && marks.every((x) => x.v === 'none' || x.v == null) && marks.some((x) => x.v === 'none'),
    };
  }
  const short = (rel) => rel.split('/').pop();
  function renderViewed() {
    const blocks = new Map(fileBlocks().map((b) => [b.rel, b]));
    for (const el of panel.querySelectorAll('[data-viewed-for]')) {
      const v = isViewed(el.getAttribute('data-viewed-for'), blocks);
      el.textContent = v ? '✓ viewed' : '';
    }
    const box = $('.prs-progress');
    if (inBackstory()) { box.innerHTML = ''; return; }
    const all = DATA.chapters.map((c, i) => progressOf(i + 1, blocks));
    if (all.some((p) => p.noToggle) && !all.some((p) => p.viewed || p.unviewed.length)) { box.innerHTML = ''; return; } // no Viewed toggles on this page to read
    for (const el of panel.querySelectorAll('[data-prog-for]')) {
      const p = all[Number(el.getAttribute('data-prog-for')) - 1];
      if (!p || !p.due || p.noToggle) { el.textContent = ''; continue; }
      const complete = p.viewed === p.due;
      el.textContent = complete ? '✓' : `${p.viewed}/${p.due}`;
      el.classList.toggle('prs-done', complete);
      el.title = complete ? 'Every file to mark viewed here is ticked' : `${p.viewed} of ${p.due} marked viewed`;
    }
    const linkList = (rels) => rels.map((rel) => `<code data-rel="${esc(rel)}" title="Scroll to ${esc(rel)}">${esc(short(rel))}</code>`).join(', ');
    if (state.n === 0) {
      const due = all.reduce((a, p) => a + p.due, 0);
      const viewed = all.reduce((a, p) => a + p.viewed, 0);
      const left = all.map((p, i) => ({ p, i })).filter(({ p }) => p.viewed < p.due).map(({ i }) => i + 1);
      box.innerHTML = !due ? '' : viewed === due
        ? `<span class="prs-done">✓ All ${due} files marked viewed</span>`
        : `<b>${viewed} of ${due}</b> files marked viewed${left.length ? ` · chapter${left.length > 1 ? 's' : ''} ${left.join(', ')} still ${left.length > 1 ? 'have' : 'has'} some to go` : ''}`;
      return;
    }
    const p = all[state.n - 1];
    if (!p || !p.due) { box.innerHTML = '<span>Nothing to mark viewed in this chapter</span>'; return; }
    if (p.viewed === p.due) { box.innerHTML = `<span class="prs-done">✓ All ${p.due} marked viewed</span>`; return; }
    box.innerHTML = `<b>${p.viewed} of ${p.due}</b> marked viewed`
      + (p.unviewed.length ? ` · still to mark: ${linkList(p.unviewed)}` : '')
      + (p.unknown.length ? ` · ${p.unknown.length} not loaded yet` : '');
  }
  $('.prs-note').addEventListener('click', (e) => {
    const ref = e.target.closest('[data-rel]');
    if (ref) scrollToFile(ref.getAttribute('data-rel'));
  });
  // Classic /files ticks a checkbox (no attribute change), and Refined GitHub's batch
  // helpers click many toggles at once, so also look again shortly after any click or change.
  const recheck = () => { setTimeout(renderViewed, 300); setTimeout(renderViewed, 1200); };
  document.addEventListener('change', recheck, true);
  document.addEventListener('click', recheck, true);

  function fileItem(f, n) {
    const st = status(f.rel, n);
    const chs = chaptersOf(f.rel);
    const why = inBackstory()
      ? (chs.length ? `story chapter${chs.length > 1 ? 's' : ''} ${chs.join(', ')}` : '')
      : n === 0
        ? `chapter${chs.length > 1 ? 's' : ''} ${chs.join(', ')}`
        : `${st ? st.text : ''}${f.partial && st && st.kind !== 'later' && f.note ? ` (here: ${f.note})` : ''}`;
    // "why": the file's How it got here, collapsed under the row
    const story = !inBackstory() && n ? DATA.chapters[n - 1].files.find((x) => x.rel === f.rel) || f : f;
    const how = inBackstory() ? '' : fileBackstory(story);
    const whyLink = how ? ` <button class="prs-linkish prs-whylink" aria-expanded="false" title="How it got here">why</button>` : '';
    const whyBox = how ? `<div class="prs-whybox" hidden>${how}</div>` : '';
    const lines = (f.lines || []).map((l) => {
      const side = l.side === 'L' ? 'L' : 'R';
      const range = `${side === 'L' ? 'old ' : ''}line${l.end && l.end !== l.start ? `s ${l.start}–${l.end}` : ` ${l.start}`}`;
      return `<li><span ${refAttrs(f.rel, { side, start: l.start, end: l.end || l.start })}>${range}</span>${l.label ? ` ${esc(l.label)}` : ''}</li>`;
    }).join('');
    return `<li data-file="${esc(f.rel)}"><code ${refAttrs(f.rel, null)}>${esc(f.rel)}</code><span class="prs-viewed" data-viewed-for="${esc(f.rel)}"></span>${whyLink}`
      + `${why ? `<span class="prs-why${st ? ` prs-st-${st.kind}` : ''}">${esc(why)}</span>` : ''}${lines ? `<ul class="prs-lines">${lines}</ul>` : ''}${whyBox}</li>`;
  }

  function sessionsHtml() {
    if (!sessions.size) return '';
    const items = [...sessions.values()].map((x) => `<li>${esc(x.label || x.title || x.id.slice(0, 8))} ${sessionRef({ session: x.id })}</li>`).join('');
    return `<p class="prs-bs-at">From ${sessions.size} Claude Code session${sessions.size === 1 ? '' : 's'}:</p><ul>${items}</ul>`;
  }

  /** "4 to mark viewed · 2 come back later · 1 already finished" for chapter n. */
  function filesSummary(n) {
    const kinds = { mark: 0, later: 0, done: 0 };
    for (const f of DATA.chapters[n - 1].files) { const st = status(f.rel, n); if (st) kinds[st.kind]++; }
    return [kinds.mark && `${kinds.mark} to mark viewed`, kinds.later && `${kinds.later} come${kinds.later === 1 ? 's' : ''} back later`, kinds.done && `${kinds.done} already finished`].filter(Boolean).join(' · ');
  }
  function filesBox(title, summary, items) {
    return `<details class="prs-filesbox"${state.filesOpen ? ' open' : ''}><summary><h2 class="prs-h">${esc(title)}</h2>${summary ? `<span class="prs-sum">${esc(summary)}</span>` : ''}</summary><ul class="prs-files">${items}</ul></details>`;
  }

  function renderBody() {
    const ch = chapter();
    const bsv = inBackstory();
    const list = steps();
    const stepList = [`<li data-n="0" class="${state.n === 0 ? 'prs-current' : ''}">${bsv ? 'How it got here' : 'Overview'} <span class="prs-count">(${DATA.files.length})</span></li>`]
      .concat(list.map((c, i) => `<li data-n="${i + 1}" class="${i + 1 === state.n ? 'prs-current' : ''}">${bsv ? '' : `${i + 1}. `}${esc(c.title.replace(/^Chapter \d+:\s*/, ''))} <span class="prs-count">(${c.files.length})</span>${bsv ? '' : `<span class="prs-stepprog" data-prog-for="${i + 1}"></span>`}</li>`)).join('');
    $('.prs-title').textContent = bsv ? `Backstory: ${ch ? ch.title.replace(/^\d+\.\s*/, '') : 'how it got here'}` : ch ? ch.title : `Overview: ${DATA.pr.title || ''}`;
    $('.prs-title').title = $('.prs-title').textContent;
    $('.prs-prev').disabled = state.n === 0;
    $('.prs-next').disabled = state.n === list.length;
    pilled = new Set();
    let body;
    if (bsv) {
      linkScope = ch ? ch.files.map((f) => f.rel) : allRels;
      const banner = '<div class="prs-bs-banner">Backstory view: how this got here, in the order it happened. <button class="prs-linkish" data-view="story">Back to the story</button></div>';
      const intro = ch
        ? momentHtml(ch)
        : `${BS.summary ? markdown(BS.summary) : '<p class="prs-empty">No summary written yet.</p>'}${sessionsHtml()}`;
      const files = (ch ? ch.files : DATA.files).map((f) => fileItem(f, state.n)).join('');
      const head = ch ? `Files changed in this step (${ch.files.length})` : `All files (${DATA.files.length})`;
      body = `${banner}<div class="prs-md">${intro}</div><h2 class="prs-h">${head}</h2>`
        + `<ul class="prs-files">${files || '<li class="prs-empty">No files of the diff in this step.</li>'}</ul>`;
    } else if (!ch) {
      linkScope = allRels;
      const intro = overviewMd
        ? markdown(overviewMd)
        : `${DATA.summary ? `<p>${inline(DATA.summary)}</p>` : ''}${DATA.plan ? `<p>${inline(DATA.plan)}</p>` : ''}`;
      const files = DATA.files.map((f) => fileItem(f, 0)).join('');
      const bsTop = BS && (BS.summary || sessions.size) ? backstoryBlock({ summary: BS.summary }, sessionsHtml()) : '';
      body = `<div class="prs-md">${intro}</div>${bsTop}${filesBox(`All files (${DATA.files.length})`, `${DATA.chapters.length} chapters`, files)}`;
    } else {
      linkScope = ch.files.map((f) => f.rel);
      const story = ch.narrative
        ? markdown(ch.narrative)
        : `${ch.headline ? `<p><strong>${inline(ch.headline)}</strong></p>` : ''}${ch.scenario ? `<p>The scenario: ${inline(ch.scenario)}</p>` : ''}${ch.summary ? `<p>${inline(ch.summary)}</p>` : ''}<p class="prs-empty">This chapter's story isn't written yet.</p>`;
      const comments = (ch.comments || []).map((c, i) => {
        const general = !c.line || /^\(/.test(c.path || '');
        const ref = !general && resolveRef(c.path);
        const name = ref ? `<code ${refAttrs(ref.rel, { side: 'R', start: c.line, end: c.line })}>${esc(c.path)}</code>` : `<code>${esc(c.path)}</code>`;
        const where = general ? 'General PR comment' : `On ${name} line ${c.line}`;
        return `<div class="prs-comment"><div class="prs-where"><span>${where}</span><button class="prs-copy" data-i="${i}">Copy</button></div><pre>${esc(c.body)}</pre></div>`;
      }).join('');
      const files = ch.files.map((f) => fileItem(f, state.n)).join('');
      body = `<div class="prs-md">${story}</div>${backstoryBlock(ch.backstory)}
        ${comments ? `<h2 class="prs-h">${esc(COMMENTS_TITLE)}</h2>${comments}` : ''}
        ${filesBox(`Files in this chapter (${ch.files.length})`, filesSummary(state.n), files)}`;
    }
    $('.prs-body').innerHTML = `<h2 class="prs-h">${bsv ? 'Backstory steps' : 'Steps'}</h2><ol class="prs-map">${stepList}</ol>${body}<div class="prs-questions"></div>`;
    const fbox = $('.prs-body details.prs-filesbox');
    if (fbox) fbox.addEventListener('toggle', () => { if (state.filesOpen !== fbox.open) { state.filesOpen = fbox.open; saveState(); } });
    renderQuestions();
    renderViewed();
    $('.prs-body').scrollTop = 0;
  }

  // one click handler for everything in the panel body
  $('.prs-body').addEventListener('click', (e) => {
    const step = e.target.closest('ol.prs-map li[data-n]');
    if (step) return go(Number(step.getAttribute('data-n')));
    const copyBtn = e.target.closest('.prs-copy');
    if (copyBtn) return copy(chapter().comments[Number(copyBtn.getAttribute('data-i'))].body, copyBtn);
    const textBtn = e.target.closest('[data-copy-text]');
    if (textBtn) return copyText(textBtn.getAttribute('data-copy-text'), textBtn);
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) return setView(viewBtn.getAttribute('data-view'));
    const whyBtn = e.target.closest('.prs-whylink');
    if (whyBtn) {
      const box = whyBtn.closest('li').querySelector('.prs-whybox');
      if (box) { box.hidden = !box.hidden; whyBtn.setAttribute('aria-expanded', String(!box.hidden)); }
      return;
    }
    const ref = e.target.closest('[data-rel]');
    if (!ref) return;
    const rel = ref.getAttribute('data-rel');
    if (ref.hasAttribute('data-start')) scrollToLine(rel, ref.getAttribute('data-side') || 'R', +ref.getAttribute('data-start'), +ref.getAttribute('data-end'));
    else scrollToFile(rel);
  });

  /** Switch between the story (the default) and the backstory view. Only an explicit switch gets here, so only then is the view saved. */
  function setView(view) {
    const next = view === 'backstory' && BS_CH.length ? 'backstory' : 'story';
    if (next === state.view) return;
    const keep = state.n;
    state.view = next;
    state.n = clampN(state.other, next);
    state.other = keep;
    state.all = false;
    message('');
    saveState();
    renderBody();
    apply();
    reportPosition();
    if (state.n === 0) window.scrollTo({ top: 0 });
    else if (chapter().files[0]) scrollToFile(chapter().files[0].rel, true);
  }

  function go(n) {
    if (n < 0 || n > steps().length) return;
    const from = state.n;
    const left = !inBackstory() && from > 0 && n > from ? progressOf(from, new Map(fileBlocks().map((b) => [b.rel, b]))).unviewed : [];
    state.n = n;
    state.all = false;
    message('');
    saveState();
    renderBody();
    apply();
    reportPosition();
    if (n === 0) window.scrollTo({ top: 0 });
    else if (chapter().files[0]) scrollToFile(chapter().files[0].rel, true);
    if (left.length) message(`Chapter ${from} still has ${left.length} to mark viewed: ${left.map(short).join(', ')}. No rush: Prev goes back, or tick them later.`);
  }

  // Highlight rows for a few seconds. GitHub's React view can swap a row for a new
  // element as it renders around the scroll, so the rows are found again (getEls) each time.
  let flashTimer = 0;
  let flashing = () => [];
  function flash(getEls) {
    const find = typeof getEls === 'function' ? getEls : () => getEls;
    for (const el of document.querySelectorAll('[data-dsm-flash]')) el.removeAttribute('data-dsm-flash');
    flashing = find;
    for (const el of find()) el.setAttribute('data-dsm-flash', '');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashing = () => []; for (const el of document.querySelectorAll('[data-dsm-flash]')) el.removeAttribute('data-dsm-flash'); }, 4000);
  }
  const spot = (frac) => (frac ? window.innerHeight * frac : 72);
  function scrollTo(el, frac) {
    const top = el.getBoundingClientRect().top + window.scrollY - spot(frac);
    window.scrollTo({ top: Math.max(0, top) });
  }
  // A long jump makes GitHub render the files it passes, which pushes the target
  // down after the first scroll. So look again for ≈2s and scroll back onto it,
  // until it holds still or Eric scrolls himself.
  let settleToken = 0;
  function settle(getEl, frac) {
    const token = ++settleToken;
    let mine = true;
    const off = () => { mine = false; };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    const opts = { passive: true, capture: true };
    for (const ev of events) window.addEventListener(ev, off, opts);
    // (the mousedown of the click that started this has already happened, so only a new one stops it)
    const steps = [80, 200, 400, 700, 1100, 1600, 2200];
    steps.forEach((t, i) => setTimeout(() => {
      const last = i === steps.length - 1;
      if (token === settleToken && mine) {
        const el = getEl();
        if (el && Math.abs(el.getBoundingClientRect().top - spot(frac)) > 24) scrollTo(el, frac);
        for (const r of flashing()) if (!r.hasAttribute('data-dsm-flash')) r.setAttribute('data-dsm-flash', '');
      }
      if (last) for (const ev of events) window.removeEventListener(ev, off, opts);
    }, t));
  }
  function scrollToFile(rel, quiet) {
    const b = blockOf(rel);
    if (!b) { if (!quiet) message(`${rel} isn't loaded on the page yet. Scroll the diff and try again.`); return false; }
    scrollTo(b.el);
    if (!quiet) flash(() => { const x = blockOf(rel); return x ? [x.el] : []; });
    settle(() => { const x = blockOf(rel); return x && x.el; });
    return true;
  }
  /** Scroll a line range into view and highlight it. Never expands a hunk or a collapsed file. */
  function scrollToLine(rel, side, startLine, endLine) {
    let target = lineCell(rel, side, startLine);
    let note = '';
    let at = startLine;
    if (!target) {
      // nearest line GitHub has rendered for this file and side
      const prefix = `diff-${pathToSha.get(rel)}${side}`;
      const near = [...document.querySelectorAll(`[data-line-anchor^="${prefix}"]`)]
        .map((c) => ({ c, n: +c.getAttribute('data-line-anchor').slice(prefix.length) }))
        .filter((x) => x.n > 0).sort((a, b) => Math.abs(a.n - startLine) - Math.abs(b.n - startLine))[0];
      if (near) { target = near.c; at = near.n; note = `Line ${startLine} isn't in the diff ${HOST} shows, so this is the nearest line, ${near.n}. ${HOST}'s expand arrows above it show more.`; }
    }
    if (!target) {
      scrollToFile(rel, true);
      message(`Line ${startLine} of ${rel.split('/').pop()} isn't on the page. The file may be collapsed (Viewed files collapse) or not loaded. Expand it in ${HOST}, then click again.`);
      return false;
    }
    const rowOf = (c) => c.closest('tr') || c;
    const rowsNow = () => {
      const rows = [];
      for (let n = startLine; n <= Math.max(startLine, endLine || startLine) && n < startLine + 400; n++) {
        const c = lineCell(rel, side, n);
        if (c && !rows.includes(rowOf(c))) rows.push(rowOf(c));
      }
      if (!rows.length) { const c = lineCell(rel, side, at); if (c) rows.push(rowOf(c)); }
      return rows;
    };
    scrollTo(rowOf(target), 0.25);
    flash(rowsNow);
    settle(() => { const c = lineCell(rel, side, at); return c && rowOf(c); }, 0.25);
    message(note);
    return true;
  }

  function copy(text, btn) {
    const done = (ok) => { btn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
    const fallback = () => {
      const pre = btn.closest('.prs-comment').querySelector('pre');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  function copyText(text, btn) {
    const was = btn.textContent;
    const done = (ok) => { btn.textContent = ok ? 'copied' : text; setTimeout(() => { btn.textContent = was; }, ok ? 1200 : 4000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  }

  function setWidth(w) {
    state.width = Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.7));
    document.documentElement.style.setProperty('--dsm-w', (state.collapsed ? 36 : state.width) + 'px');
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
    const up = () => { saveState(); panel.classList.remove('prs-dragging'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  $('.prs-toggle').onclick = () => { setCollapsed(!state.collapsed); saveState(); };
  $('.prs-prev').onclick = () => go(state.n - 1);
  $('.prs-next').onclick = () => go(state.n + 1);
  $('.prs-close').onclick = () => { destroy(); if (opts.onClose) opts.onClose(); };
  const onResize = () => setWidth(state.width);
  window.addEventListener('resize', onResize);

  // ---------- a #diff-<sha> jump to a file outside the chapter
  // Refined GitHub's j/k and "jump to first unviewed file" set the hash to the
  // next file in page order without checking it's visible. Step on, in the same
  // direction, to the next file that is in the chapter.
  let lastHashIdx = -1;
  function onHashChange() {
    const m = /^#diff-([0-9a-f]{64})/.exec(location.hash);
    const rel = m && shaToPath.get(m[1]);
    if (!rel) return;
    const blocks = fileBlocks();
    const idx = blocks.findIndex((b) => b.rel === rel);
    const want = inChapter();
    if (state.all || state.n === 0 || want.has(rel) || idx < 0) { lastHashIdx = idx; return; }
    const dir = idx >= lastHashIdx ? 1 : -1;
    for (let i = idx + dir; i >= 0 && i < blocks.length; i += dir) {
      if (!want.has(blocks[i].rel)) continue;
      lastHashIdx = i;
      location.replace('#diff-' + pathToSha.get(blocks[i].rel));
      return;
    }
    const where = chaptersOf(rel);
    message(`${rel.split('/').pop()} isn't in this chapter${where.length ? ` (it's in chapter ${where.join(', ')})` : ''}, and there's no chapter file past it.`);
  }
  window.addEventListener('hashchange', onHashChange);

  // ---------- the status light: bridge, story, a Claude session listening
  let health = null;
  let healthTimer = 0;
  function healthChecks(h, err) {
    if (err) {
      const why = err.code === 'token' ? ['The bridge rejected the token', 'Copy it again from diff-story setup into the extension options']
        : err.code === 'old' ? ['The bridge is older than this panel', 'Restart it: diff-story serve']
          : ['The bridge isn\'t reachable', 'Start it: diff-story serve'];
      return { level: 'error', checks: [{ ok: false, bad: true, name: 'Bridge', detail: why[0], fix: why[1] }] };
    }
    const checks = [{ ok: true, name: 'Bridge', detail: `reachable, token accepted (${h.bridge.version})` }];
    if (h.story) checks.push({ ok: h.story.ok, name: 'Story', detail: h.story.ok ? `found (${h.story.id})` : 'not found for this page' });
    const l = h.listening || {};
    checks.push(l.ok
      ? { ok: true, name: 'Claude listening', detail: (l.consumers || []).map((c) => `${c.consumer}${c.state === 'handling' ? ', answering a question' : ''}`).join(', ') }
      : { ok: false, name: 'Claude listening', detail: 'no Claude session is listening; questions will wait in the inbox', fix: l.start || 'diff-story wait --consumer pr-story' });
    if (h.autoBuild && h.autoBuild.enabled) checks.push({ ok: true, name: 'autoBuild', detail: 'on' });
    if (h.autoAnswer && h.autoAnswer.enabled) checks.push({ ok: true, name: 'autoAnswer', detail: 'on: questions get an answer from the configured command' });
    const listening = l.ok || (h.autoAnswer && h.autoAnswer.enabled);
    return { level: !listening || (h.story && !h.story.ok) ? 'warn' : 'ok', checks, listening };
  }
  function renderHealth(res) {
    const btn = $('.prs-light');
    btn.setAttribute('data-level', res.level);
    btn.title = res.checks.map((c) => `${c.ok ? '✓' : c.bad ? '✗' : '!'} ${c.name}: ${c.detail}`).join('\n') + '\n(click for details)';
    $('.prs-health').innerHTML = `<ul>${res.checks.map((c) => `<li><span class="${c.ok ? 'prs-hok' : c.bad ? 'prs-herr' : 'prs-hwarn'}">${c.ok ? '✓' : c.bad ? '✗' : '!'}</span> <b>${esc(c.name)}</b>: ${esc(c.detail)}${c.fix ? `<br><span class="prs-why">${esc(c.fix.replace(/^In a Claude Code session, run as a background task: /, 'In Claude Code, run as a background task: '))}</span>` : ''}</li>`).join('')}</ul>`;
    const hint = $('.prs-askhint');
    const showHint = opts.ask && res.level !== 'ok' && !res.listening;
    hint.hidden = !showHint;
    if (showHint) {
      hint.innerHTML = res.level === 'error'
        ? `${esc(res.checks[0].detail)}. Questions can't be sent until it's back.`
        : 'No Claude session is listening; questions will wait. Start one in Claude Code as a background task: <code>diff-story wait --consumer pr-story</code>';
    }
  }
  async function refreshHealth() {
    if (!opts.status) return;
    try { health = healthChecks(await opts.status()); } catch (err) { health = healthChecks(null, err || {}); }
    renderHealth(health);
  }
  $('.prs-light').addEventListener('click', () => {
    const box = $('.prs-health');
    box.hidden = !box.hidden;
    $('.prs-light').setAttribute('aria-expanded', String(!box.hidden));
  });
  if (opts.status) {
    refreshHealth();
    healthTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshHealth(); }, 10000);
  } else $('.prs-light').hidden = true;

  // ---------- where Eric is: the step and the file at the top of the screen
  let posTimer = 0;
  let lastPos = '';
  let topFile = null;
  function fileAtTop() {
    const y = 140;
    let best = null;
    for (const { rel, el } of fileBlocks()) {
      if (el.hasAttribute('data-dsm-hidden')) continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top <= y && r.bottom > y) return rel;
      if (r.top > y && (!best || r.top < best.top)) best = { rel, top: r.top };
    }
    return best && best.top < window.innerHeight ? best.rel : null;
  }
  function reportPosition() {
    if (!opts.onPosition) return;
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      topFile = fileAtTop();
      const p = { step: inBackstory() ? null : state.n, chapter: stepLabel(), file: topFile };
      const key = JSON.stringify(p);
      if (key === lastPos) return;
      lastPos = key;
      opts.onPosition(p);
    }, 1200);
  }
  const onScroll = () => reportPosition();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---------- questions: sent through opts.ask, answers come back through opts.loadQuestions
  let questions = [];
  let qaTimer = 0;
  let qaTick = 0;
  const stepLabel = () => (inBackstory() ? `Backstory: ${chapter() ? chapter().title : 'How it got here'}` : chapter() ? chapter().title : 'Overview');
  const forStep = (q) => (inBackstory()
    ? String(q.chapter || '') === stepLabel() || (state.n === 0 && /^Backstory/.test(String(q.chapter || '')))
    : !/^Backstory/.test(String(q.chapter || '')) && (state.n === 0 || q.step === state.n));
  function renderQuestions() {
    const box = $('.prs-questions');
    if (!box) return;
    const list = questions.filter(forStep);
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h2 class="prs-h">Questions${state.n ? ' on this step' : ''} (${list.length})</h2>` + list.map((q) => {
      const when = q.at ? new Date(q.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const where = [state.n === 0 && q.step ? `chapter ${q.step}` : '', q.file ? q.file.split('/').pop() : ''].filter(Boolean).join(', ');
      const answers = (q.answers || []).map((a) => `<div class="prs-a prs-md">${markdown(a.text)}</div>`).join('');
      return `<div class="prs-qa"><div class="prs-q">${esc(q.text)}</div><div class="prs-qmeta">${esc([when, where].filter(Boolean).join(' · '))}</div>`
        + `${answers || '<div class="prs-wait">Waiting for an answer from the Claude session</div>'}</div>`;
    }).join('');
  }
  async function refreshQuestions() {
    if (!opts.loadQuestions) return;
    try {
      const next = await opts.loadQuestions();
      if (!Array.isArray(next)) return;
      const changed = JSON.stringify(next) !== JSON.stringify(questions);
      questions = next;
      if (changed) renderQuestions();
    } catch (e) { /* the bridge may be down; try again on the next tick */ }
  }
  // every 4s while a question is waiting, otherwise every 30s
  function pollQuestions() {
    qaTick++;
    const waiting = questions.some((q) => !(q.answers || []).length);
    if ((waiting || qaTick % 8 === 0) && document.visibilityState === 'visible') refreshQuestions();
  }
  if (opts.loadQuestions) { refreshQuestions(); qaTimer = setInterval(pollQuestions, 4000); }

  const askForm = $('.prs-ask');
  const askText = askForm.querySelector('textarea');
  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = askText.value.trim();
    if (!text || !opts.ask) return;
    const btn = askForm.querySelector('button');
    btn.disabled = true;
    try {
      await opts.ask({ text, step: inBackstory() ? null : state.n, chapter: stepLabel(), file: topFile || fileAtTop() });
      askText.value = '';
      message(health && !health.listening ? 'Queued in the bridge inbox. No Claude session is listening yet, so it will wait.' : 'Sent to the bridge inbox.');
      await refreshQuestions();
    } catch (err) {
      message(`Couldn't send the question: ${err && err.message ? err.message : err}`);
    } finally {
      btn.disabled = false;
    }
  });
  askText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); askForm.requestSubmit(); } });
  // keep the host page's keyboard shortcuts out of the panel while typing
  for (const type of ['keydown', 'keypress', 'keyup']) panel.addEventListener(type, (e) => e.stopPropagation());

  function destroy() {
    observer.disconnect();
    clearTimeout(pending);
    clearTimeout(msgTimer);
    clearTimeout(posTimer);
    clearTimeout(flashTimer);
    clearInterval(healthTimer);
    settleToken++;
    clearInterval(qaTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('hashchange', onHashChange);
    unhideAll();
    host.remove();
    style.remove();
    document.documentElement.classList.remove(HOST_ID + '-docked');
    document.documentElement.style.removeProperty('--dsm-w');
    document.removeEventListener('change', recheck, true);
    document.removeEventListener('click', recheck, true);
    if (window.__diffStoryOverlay === api) delete window.__diffStoryOverlay;
  }

  document.head.appendChild(style);
  shadow.appendChild(panel);
  document.body.appendChild(host);
  document.documentElement.classList.add(HOST_ID + '-docked');
  setWidth(Number.isFinite(init.width) ? state.width : Math.min(state.width, Math.round(window.innerWidth * 0.4)));
  setCollapsed(state.collapsed);
  renderBody();
  apply();
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  reportPosition();

  const api = {
    destroy, go, setView, apply, scrollToLine, scrollToFile, refreshQuestions, setCollapsed, state, data: INPUT,
    get seen() { return seen; },
    get health() { return health; },
    refreshHealth,
    summary() {
      const label = inBackstory()
        ? (state.n ? `backstory step ${state.n} of ${BS_CH.length}` : `backstory overview (${BS_CH.length} steps)`)
        : state.n ? `chapter ${state.n} of ${DATA.chapters.length}` : `overview (${DATA.chapters.length} chapters)`;
      return `diff story: ${label}, ${seen.shown} of ${inChapter().size} files found on the page (${seen.found} file blocks seen, ${DATA.files.length} in the diff)`;
    },
  };
  window.__diffStoryOverlay = api;
  return api;
}
