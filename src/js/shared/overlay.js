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
 * "Since you read it" chapters (a chapter with `since: {from, to}`) tell the
 * commits that came after Eric read the story, and come first. They aren't
 * numbered: the chapters after them keep the numbers they were read with. A
 * file one of them lists is marked viewed there (the newest one wins), since
 * the chapters after it were already read.
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
 *   drafts         {load(), act(chapter, index, action)}: each returns a Promise of {drafts: [{chapter, index, status:
 *                  'draft'|'posted'|'pending', dismissed, url, added}], error}. action is posted, unposted, dismiss,
 *                  restore, review (Add to my review) or settle (an added draft has shown up, see draftView).
 *   reloadPage()   reloads the page, keeping the panel's step and scroll; offered on a draft just added to the review
 *   onFilter(f)    called after each filter pass with {n, view, all}; the local page folds other chapters' lines with it
 *   reveal(rel, side, start, end)  called before a jump to lines, so a page that folds lines can open them
 *   pageAt         when this page loaded, in ms (performance.timeOrigin); a draft added after it isn't on the page yet
 *   freshness()    returns a Promise of {state: 'current'|'stale'|'unknown'|'n/a', story_head, current_head, newer,
 *                  changed_files, chapters_touched, updated, error}: is the story up to date with the PR's latest commit?
 *                  updated ({from, to, newer, retold, changed_files, chapters_touched}) is a current story's last update
 *                  when it has no "Since you read it" chapter, so the panel can still say what's new
 *   requestUpdate(base_sha, {retell}) asks for the story to be updated from that commit (a build request, mode 'update'):
 *                  by default a "Since you read it" chapter for the new commits, or with retell a whole new story
 *   onRead(r)      called with {chapter (its key), step, title, reason: 'time'|'viewed'|'inferred', seconds, head_sha} when Eric
 *                  leaves a chapter he spent READ_MS on (counted while the tab shows), or ticks the last of its files viewed,
 *                  or ('inferred') the page already had all its files Viewed and read.json has no record of it
 *   readAfterMs    how long counts as reading a chapter (READ_MS, 30s)
 *   reads()        returns a Promise of the bridge's GET /read: {reads, since, changed: [{step, files}],
 *                  stale_comments: [{step, index}]}: what changed in chapters he read, after he read them
 *   host           name of the page that owns the diff, for messages ("GitHub")
 *   commentsTitle  heading for the chapter's drafted comments ("Draft comments")
 */
// ---------- drafts added to his pending review (no DOM here, so node tests can use these)
/**
 * How the panel shows one draft row from the bridge: 'dismissed', 'posted', 'pending', 'added' or 'draft'.
 * 'added' is Add to my review's own state: it's in his pending review, but GitHub doesn't redraw an open
 * Files changed page for that, so this page doesn't show it yet. It turns into the usual posted or pending
 * display once gh matches it on a page loaded after the add, or the comment turns up on the page (onPage).
 * settle: the add is confirmed, so the bridge can drop its `added` mark.
 */
export function draftView(row, { pageAt = 0, onPage = false } = {}) {
  const r = row || { status: 'draft', dismissed: false };
  if (r.dismissed) return { show: 'dismissed', settle: false };
  const known = r.status === 'posted' || r.status === 'pending' ? r.status : 'draft';
  if (!r.added) return { show: known, settle: false };
  const github = r.source === 'github';
  if (r.status === 'posted') return { show: 'posted', settle: github };
  if (github && r.status === 'pending' && pageAt > (Date.parse(r.added.at) || 0)) return { show: 'pending', settle: true };
  if (onPage) return { show: 'pending', settle: false };
  return { show: 'added', settle: false };
}
const plainText = (t) => String(t || '').toLowerCase().replace(/```[a-z]*\n?/g, ' ').replace(/\]\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Does one of these comment texts on the page (rendered markdown) show this draft's body? */
export function shownIn(texts, body) {
  const want = plainText(body).slice(0, 160);
  if (want.length < 8) return false;
  return texts.some((t) => plainText(t).includes(want));
}
/** A chapter's stable key, as the bridge's read.json uses it: its `key`, else its title without "Chapter N:". */
export function chapterKeyOf(ch) {
  if (ch && typeof ch.key === 'string' && ch.key.trim()) return ch.key.trim().slice(0, 200);
  return String((ch && ch.title) || '').replace(/^\s*chapter\s+\d+\s*[:.–—-]\s*/i, '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}
export const READ_MS = 30000;
/**
 * Where each file is marked viewed: the LAST chapter that lists it (earlier ones say "comes back in chapter N"),
 * except that a "Since you read it" chapter (one with `since`) finishes its files, the newest (first) one winning.
 */
export function finishedInOf(chapters) {
  const fin = {};
  chapters.forEach((ch, i) => (ch.files || []).forEach((f) => { fin[f.rel] = i + 1; }));
  for (let i = chapters.length - 1; i >= 0; i--) if (chapters[i].since) (chapters[i].files || []).forEach((f) => { fin[f.rel] = i + 1; });
  return fin;
}
const PILL_MARK = /\u0001(\d+)\u0001/g;
const pillMarker = (i) => `\u0001${i}\u0001`;
/**
 * Fills a chapter story's pill markers (pillMarker(i) for the i-th file mention, marks[i] its file) in reading order:
 * a file's last mention gets pillFor(rel, false), its first (when there's more than one) pillFor(rel, true), the rest nothing.
 */
export function placePills(html, marks, pillFor) {
  const first = new Map();
  const last = new Map();
  marks.forEach((rel, i) => { if (!first.has(rel)) first.set(rel, i); last.set(rel, i); });
  return String(html).replace(PILL_MARK, (m, k) => {
    const i = Number(k);
    const rel = marks[i];
    if (rel == null) return '';
    if (last.get(rel) === i) return pillFor(rel, false);
    return first.get(rel) === i ? pillFor(rel, true) : '';
  });
}
export { pillMarker };
/** GitHub's diff of a commit range in a PR: /owner/repo/pull/N/files/<from>..<to> (or /changes/…). {from, to} or null. */
export function rangeOfPath(pathname) {
  const m = /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\/?$/.exec(String(pathname || ''));
  return m ? { from: m[1], to: m[2] } : null;
}
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
/** The step (1-based) of the "Since you read it" chapter for the range this page shows, or null. */
export function rangeStepOf(chapters, pathname) {
  const r = rangeOfPath(pathname);
  if (!r) return null;
  const i = chapters.findIndex((ch) => ch.since && sameSha(ch.since.from, r.from) && sameSha(ch.since.to, r.to));
  return i < 0 ? null : i + 1;
}
/**
 * The link to GitHub's diff of just a chapter's commits. /files/<from>..<to> loads as is, logged in or out
 * (checked 2026-10-21); /changes/<from>..<to> redirects there when logged out.
 */
export const rangeUrl = (prUrl, since) => (prUrl && since ? `${String(prUrl).replace(/\/+$/, '')}/files/${since.from}..${since.to}` : null);
/** Each step's chapter number, or null for a "Since you read it" chapter: those aren't numbered, so the rest keep the numbers they were read with. */
export function chapterNumbers(chapters) {
  let k = 0;
  return chapters.map((ch) => (ch.since ? null : ++k));
}
/**
 * Chapters he reviewed before the panel tracked reads (or with the panel closed): every file the chapter marks
 * viewed was already Viewed the first time this page could see all of them, and read.json has no record of it.
 * Only that first look counts, so ticking a later chapter's files while reading an earlier one doesn't read it.
 * @param {{due: number, viewed: number, unknown: string[], noToggle: boolean}[]} progress progressOf() per step
 * @param {object|null} readInfo the bridge's GET /read; nothing is inferred until it has loaded
 * @param {Map<number, boolean>} firstLook step -> complete at the first look; filled in here
 * @returns {number[]} the steps to record as read
 */
export function inferReadSteps(chapters, progress, readInfo, firstLook) {
  if (!readInfo || !readInfo.reads) return [];
  const out = [];
  progress.forEach((p, i) => {
    const n = i + 1;
    if (firstLook.has(n) || !p || !p.due || p.noToggle || p.unknown.length) return; // not loaded on the page yet: look again later
    const complete = p.viewed === p.due;
    firstLook.set(n, complete);
    if (complete && !readInfo.reads[chapterKeyOf(chapters[i])]) out.push(n);
  });
  return out;
}
/**
 * The steps whose chapter he's read (read.json has its key) and that haven't changed since he read them. A file
 * such a chapter finishes isn't "viewed early" from an earlier chapter: he's been through it already.
 * @param {object|null} readInfo the bridge's GET /read: {reads, changed: [{step}]}
 */
export function readStepsOf(chapters, readInfo) {
  const reads = (readInfo && readInfo.reads) || {};
  const changed = new Set(((readInfo && readInfo.changed) || []).map((c) => c.step));
  return new Set(chapters.map((ch, i) => (reads[chapterKeyOf(ch)] && !changed.has(i + 1) ? i + 1 : 0)).filter(Boolean));
}
// kept across panel re-renders on this page: a failed Add to my review, and adds already settled
const reviewErrors = new Map();
const settling = new Set();

export function storyOverlay(INPUT, opts = {}) {
  const HOST_ID = 'diff-story-panel'; // the element on the page; the panel itself lives in its shadow root
  const NS = 'dsm-panel';
  if (window.__diffStoryOverlay) window.__diffStoryOverlay.destroy();
  const DATA = JSON.parse(JSON.stringify(INPUT));
  const HOST = opts.host || 'GitHub';
  const PAGE_AT = Number.isFinite(opts.pageAt) ? opts.pageAt : (globalThis.performance && performance.timeOrigin) || Date.now();
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
  // A file is marked viewed in the LAST chapter that lists it, whether or not the earlier listings say partial,
  // or in the "Since you read it" chapter that lists it. Every earlier chapter says "Leave unviewed: comes back in chapter N".
  const finishedIn = finishedInOf(DATA.chapters);
  const chaptersOf = (rel) => DATA.chapters.map((c, i) => (c.files.some((f) => f.rel === rel) ? i + 1 : 0)).filter(Boolean);
  function status(rel, n) {
    if (inBackstory()) return null;
    const e = n && DATA.chapters[n - 1].files.find((f) => f.rel === rel);
    if (!e) return null;
    const fin = finishedIn[rel];
    if (fin != null && fin < n) return { kind: 'done', text: `Already finished in ${chName(fin)}`, short: `done in ${chShort(fin)}` };
    if (fin != null && fin > n) return { kind: 'later', text: `Leave unviewed: comes back in ${chName(fin)}${e.note ? ` (${e.note})` : ''}`, short: `back in ${chShort(fin)}` };
    return { kind: 'mark', text: 'Mark viewed', short: 'mark viewed' };
  }

  // ---------- chapter numbers: "Since you read it" chapters aren't numbered, so the others keep the numbers they were read with
  const NUMBERS = chapterNumbers(DATA.chapters);
  const isNew = (n) => !!(DATA.chapters[n - 1] && DATA.chapters[n - 1].since);
  const chNo = (n) => NUMBERS[n - 1];
  const newTitle = (n) => String(DATA.chapters[n - 1].title || 'Since you read it').replace(/:.*$/, '').trim();
  /** "chapter 3", or "Since you read it" for a new-commits chapter */
  const chName = (n) => (isNew(n) ? `“${newTitle(n)}”` : `chapter ${chNo(n)}`);
  const chShort = (n) => (isNew(n) ? 'new' : `ch ${chNo(n)}`);
  const chList = (ns) => ns.map((n) => (isNew(n) ? 'new' : chNo(n))).join(', ');
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const sha7 = (x) => String(x || '').slice(0, 7);

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
    showPosted: !!init.showPosted, // posted and dismissed drafts start hidden
    showDismissed: !!init.showDismissed,
  };
  const inBackstory = () => state.view === 'backstory';
  const steps = () => (inBackstory() ? BS_CH : DATA.chapters);
  const saveState = () => {
    if (!opts.onState) return;
    const sn = inBackstory() ? state.other : state.n;
    const bn = inBackstory() ? state.n : state.other;
    opts.onState({ n: sn, bn, view: state.view, all: state.all, collapsed: state.collapsed, width: state.width, filesOpen: state.filesOpen, showPosted: state.showPosted, showDismissed: state.showDismissed });
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
  #${NS} button.prs-light { border: 0; background: none; padding: 2px 4px; }
  #${NS} .prs-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--c-muted); vertical-align: middle; }
  #${NS} .prs-light[data-level="ok"] .prs-dot { background: var(--c-ok); }
  #${NS} .prs-light[data-level="warn"] .prs-dot { background: var(--c-warn); }
  #${NS} .prs-light[data-level="error"] .prs-dot { background: var(--c-err); }
  #${NS} .prs-health { flex-basis: 100%; margin: 2px 0; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-bg); }
  #${NS} .prs-health ul { list-style: none; margin: 0; padding: 0; }
  #${NS} .prs-health li { padding: 1px 0; }
  #${NS} .prs-health .prs-hok { color: var(--c-ok); } #${NS} .prs-health .prs-hwarn { color: var(--c-warn); } #${NS} .prs-health .prs-herr { color: var(--c-err); }
  #${NS} .prs-fresh { flex-basis: 100%; font-size: 12px; }
  #${NS} .prs-fresh:empty { display: none; }
  #${NS} .prs-fresh.prs-stale { color: var(--c-warn); }
  #${NS} .prs-fresh button { margin-left: 6px; }
  #${NS} .prs-changed { font-size: 11px; color: var(--c-warn); margin-left: 4px; white-space: nowrap; }
  #${NS} .prs-touched { font-size: 11px; color: var(--c-warn); margin-left: 4px; }
  #${NS} .prs-readchg { font-size: 11px; color: var(--c-warn); margin-left: 4px; white-space: nowrap; }
  #${NS} .prs-cstate .prs-cstale { color: var(--c-warn); }
  #${NS} .prs-new { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--c-accent); border: 1px solid currentColor; border-radius: 9px; padding: 0 5px; }
  #${NS} .prs-since { margin: 10px 0; padding: 6px 10px; border-left: 3px solid var(--c-accent); background: var(--c-accent-bg); border-radius: 0 6px 6px 0; font-size: 12px; }
  #${NS} .prs-askhint { padding: 6px 10px 0; font-size: 12px; color: var(--c-warn); background: var(--c-subtle); border-top: 1px solid var(--c-border); }
  #${NS} .prs-askhint code { font-size: 11px; }
  #${NS} .prs-askhint .prs-copyprompt { margin-left: 4px; }
  #${NS} .prs-askhint .prs-promptmore { border: 0; background: none; padding: 0 2px; color: var(--c-accent, inherit); text-decoration: underline; cursor: pointer; font-size: 11px; }
  #${NS} .prs-askhint .prs-promptlong, #${NS} .prs-askhint .prs-prompt { white-space: pre-wrap; word-break: break-all; font-size: 11px; margin: 4px 0 0; color: var(--c-fg); }
  #${NS} .prs-progress { margin: 0 0 10px; padding: 4px 8px; font-size: 12px; color: var(--c-muted); border-left: 3px solid var(--c-border); }
  #${NS} .prs-progress:empty { display: none; }
  #${NS} .prs-progress.prs-complete { border-left-color: var(--c-ok); }
  #${NS} .prs-early-box { margin: 0 0 10px; padding: 6px 8px; font-size: 12px; border: 1px solid var(--c-warn); border-radius: 6px; }
  #${NS} .prs-early-box:empty { display: none; }
  #${NS} .prs-early-box p { margin: 0 0 3px; }
  #${NS} .prs-viewed.prs-early { color: var(--c-warn); }
  #${NS} .prs-progress .prs-done { color: var(--c-ok); font-weight: 600; }
  #${NS} .prs-progress b { color: var(--c-fg); }
  #${NS} .prs-stepprog { font-size: 11px; color: var(--c-muted); margin-left: 4px; }
  #${NS} .prs-stepprog.prs-done { color: var(--c-ok); }
  #${NS} details.prs-filesbox > summary, #${NS} details.prs-allc > summary { cursor: pointer; list-style: none; margin: 18px 0 6px; }
  #${NS} details.prs-filesbox > summary::-webkit-details-marker, #${NS} details.prs-allc > summary::-webkit-details-marker { display: none; }
  #${NS} details.prs-filesbox > summary .prs-h, #${NS} details.prs-allc > summary .prs-h { display: inline; margin: 0; }
  #${NS} details.prs-filesbox > summary::before, #${NS} details.prs-allc > summary::before { content: "▸ "; color: var(--c-muted); font-size: 11px; }
  #${NS} details.prs-filesbox[open] > summary::before, #${NS} details.prs-allc[open] > summary::before { content: "▾ "; }
  #${NS} .prs-allc .prs-cgh { font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
  #${NS} .prs-allc .prs-comment { margin-bottom: 8px; }
  #${NS} .prs-allc .prs-comment pre { max-height: 5.5em; overflow: auto; }
  #${NS} .prs-cstate .prs-cdraft { font-weight: 600; }
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
  #${NS} .prs-pill.prs-more { color: var(--c-muted); border-style: dashed; }
  #${NS} .prs-st-mark { color: var(--c-ok); } #${NS} .prs-st-later { color: var(--c-warn); } #${NS} .prs-st-done, #${NS} .prs-st-viewed { color: var(--c-muted); }
  #${NS} .prs-viewed { color: var(--c-ok); font-size: 12px; margin-left: 4px; white-space: nowrap; }
  #${NS} .prs-viewed:empty { display: none; }
  #${NS} .prs-comment { margin: 0 0 12px; }
  #${NS} .prs-comment.prs-c-done { margin: 0 0 6px; padding: 4px 8px; border: 1px dashed var(--c-border); border-radius: 6px; font-size: 12px; color: var(--c-muted); }
  #${NS} .prs-comment.prs-c-done pre, #${NS} .prs-comment.prs-c-done .prs-copy { display: none; }
  #${NS} .prs-comment.prs-c-pending { border-color: var(--c-warn); }
  #${NS} .prs-cstate { font-size: 12px; color: var(--c-muted); margin-top: 2px; }
  #${NS} .prs-cstate .prs-ok { color: var(--c-ok); font-weight: 600; }
  #${NS} .prs-cstate .prs-pend { color: var(--c-warn); font-weight: 600; }
  #${NS} .prs-cstate .prs-cerr { color: var(--c-err); }
  #${NS} .prs-cstate .prs-cnote { display: block; }
  #${NS} .prs-cstate button.prs-linkish { font-size: 12px; }
  #${NS} .prs-draftsum { text-transform: none; letter-spacing: 0; font-weight: 400; }
  #${NS} .prs-drafttoggles { margin: -2px 0 6px; }
  #${NS} .prs-drafttoggles:empty { display: none; }
  #${NS} .prs-cbtns button + button { margin-left: 4px; }
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
  // A bare `:40-58` is a line in the file named last before it in the step,
  // or in the step's only file; it's drawn with that file's name in front.
  let linkScope = allRels;
  let pilled = new Set();
  let lastRef = null;
  function resolveRef(text) {
    let t = unesc(text).trim().replace(/^\.\//, '');
    let line = null;
    const lm = /^(.*?):([LR])?(\d+)(?:-[LR]?(\d+))?$/.exec(t);
    if (lm) { t = lm[1]; line = { side: lm[2] || 'R', start: +lm[3], end: +(lm[4] || lm[3]) }; }
    if (!t && line) {
      const rel = lastRef && linkScope.includes(lastRef) ? lastRef : linkScope.length === 1 ? linkScope[0] : null;
      return rel ? { rel, line, bare: true } : null;
    }
    if (!t || /\s/.test(t) || !/[./]/.test(t)) return null;
    const rel = linkScope.find((r) => r === t) || linkScope.find((r) => r.endsWith('/' + t));
    if (rel) lastRef = rel;
    return rel ? { rel, line } : null;
  }
  function refAttrs(rel, line) {
    const where = line ? ` line ${line.start}${line.end !== line.start ? `–${line.end}` : ''}` : '';
    const a = `data-rel="${esc(rel)}" title="Scroll to ${esc(rel)}${where}"`;
    return line ? `${a} data-side="${line.side}" data-start="${line.start}" data-end="${line.end}"` : a;
  }
  /**
   * The status pill on a file's mention. While a chapter's story is drawn (pillMarks set), each mention leaves a
   * marker, and placePills() puts the pill on the file's LAST mention in reading order. Elsewhere (an answer), it
   * goes on the first mention of a file the story didn't pill.
   */
  let pillMarks = null;
  function pill(rel) {
    if (!state.n) return '';
    if (pillMarks) return pillMarker(pillMarks.push(rel) - 1);
    if (pilled.has(rel)) return '';
    pilled.add(rel);
    return pillHtml(rel);
  }
  function pillHtml(rel, earlier) {
    const st = status(rel, state.n);
    if (!st) return '';
    if (earlier) return st.kind === 'mark' ? '<span class="prs-pill prs-more" title="Mark it viewed at its last mention: this chapter comes back to it below">more below</span>' : '';
    const mark = st.kind === 'mark' ? ` data-mark-for="${esc(rel)}" data-mark-short="1"` : ''; // renderViewed says "viewed ✓" once it's ticked
    return `<span class="prs-pill prs-st-${st.kind}"${mark} title="${esc(st.text)}">${esc(st.short)}</span>`;
  }
  /** A chapter's story with its pill markers filled in: the status on each file's last mention, "more below" on its first. */
  function storyWithPills(draw) {
    const marks = [];
    pillMarks = marks;
    let html;
    try { html = draw(); } finally { pillMarks = null; }
    for (const rel of marks) pilled.add(rel);
    return placePills(html, marks, pillHtml);
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
          lastRef = rel;
          const line = hit[3] ? { side: hit[2], start: +hit[3], end: +(hit[4] || hit[3]) } : null;
          return `<span ${refAttrs(rel, line)}>${text}</span>${pill(rel)}`;
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      });
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => {
      const ref = resolveRef(codes[i]);
      if (!ref) return `<code>${codes[i]}</code>`;
      const label = ref.bare ? `${esc(ref.rel.split('/').pop())}${codes[i]}` : codes[i];
      return `<code ${refAttrs(ref.rel, ref.line)}>${label}</code>${pill(ref.rel)}`;
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
    if (opts.onFilter) opts.onFilter({ n: state.n, view: state.view, all: showAll });
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
    if (!pending) pending = setTimeout(() => { pending = 0; apply(); if (waitingOnPage()) renderDrafts(); }, 150);
  });
  // a draft added to the review shows as pending as soon as its comment turns up on the page
  const waitingOnPage = () => !!state.n && !inBackstory() && draftRows.some((r) => r.chapter === state.n && r.added);

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
    <div class="prs-note"><span class="prs-count-note"></span><div class="prs-health" hidden></div><div class="prs-fresh"></div><span class="prs-msg"></span></div>
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
      const here = inBackstory() ? `${unit} ${state.n}` : chName(state.n);
      html = state.all
        ? `<span>Showing all <b>${total}</b> files. ${cap(here)}'s ${n} are listed below.</span> <button class="prs-all" aria-pressed="true">${unit[0].toUpperCase() + unit.slice(1)} files only</button>`
        : `<span>Showing <b>${n}</b> of <b>${total}</b> files, ${here}${extra}</span> <button class="prs-all" aria-pressed="false">Show all files</button>`;
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
    // viewed too early: a file whose last chapter is still to come (it comes back later, or it's only a later chapter's), never one already finished,
    // and never one whose last chapter he's already read (a review done earlier, or before read tracking)
    const n0 = inBackstory() ? 0 : state.n;
    const readSteps = readStepsOf(DATA.chapters, readInfo);
    const earlyFor = (rel) => n0 > 0 && finishedIn[rel] != null && finishedIn[rel] > n0 && !readSteps.has(finishedIn[rel]);
    for (const el of panel.querySelectorAll('[data-viewed-for]')) {
      const rel = el.getAttribute('data-viewed-for');
      const v = isViewed(rel, blocks);
      const early = v === true && earlyFor(rel);
      const tagged = !!el.parentElement && !!el.parentElement.querySelector(':scope > [data-mark-for]'); // its "Viewed ✓" tag says it
      el.textContent = v === true ? (early ? '⚠ viewed early' : tagged ? '' : '✓ viewed') : '';
      el.classList.toggle('prs-early', early);
      el.title = early ? `Marked viewed, but ${chName(finishedIn[rel])} covers more of it. You may want to unmark it until then.` : '';
    }
    // the tag on a file this chapter finishes: "Mark viewed" until its Viewed toggle is on, then "Viewed ✓"
    for (const el of panel.querySelectorAll('[data-mark-for]')) {
      const on = isViewed(el.getAttribute('data-mark-for'), blocks) === true;
      el.textContent = el.hasAttribute('data-mark-short') ? (on ? 'viewed ✓' : 'mark viewed') : `${on ? 'Viewed ✓' : 'Mark viewed'}${el.getAttribute('data-mark-rest') || ''}`;
      el.classList.toggle('prs-st-viewed', on);
      el.classList.toggle('prs-st-mark', !on);
      if (el.hasAttribute('data-mark-short')) el.title = on ? 'Viewed' : 'Mark viewed';
    }
    const earlyBox = $('.prs-early-box');
    if (earlyBox) {
      const inCh = n0 ? new Set(chapter().files.map((f) => f.rel)) : new Set();
      const early = n0 ? allRels.filter((rel) => earlyFor(rel) && isViewed(rel, blocks) === true) : [];
      earlyBox.innerHTML = early.map((rel) => (inCh.has(rel)
        ? `<p>⚠ <code data-rel="${esc(rel)}">${esc(short(rel))}</code> is marked viewed, but ${chName(finishedIn[rel])} covers more of it. You may want to unmark it until then.</p>`
        : `<p>⚠ <code>${esc(short(rel))}</code> is marked viewed early: it belongs to ${chName(finishedIn[rel])}. You may want to unmark it until then.</p>`)).join('');
    }
    const box = $('.prs-progress');
    if (!box) return;
    box.classList.remove('prs-complete');
    if (inBackstory()) { box.innerHTML = ''; return; }
    const all = DATA.chapters.map((c, i) => progressOf(i + 1, blocks));
    if (all.some((p) => p.noToggle) && !all.some((p) => p.viewed || p.unviewed.length)) { box.innerHTML = ''; return; } // no Viewed toggles on this page to read
    for (const n of inferReadSteps(DATA.chapters, all, readInfo, firstLook)) sendRead(n, 'inferred');
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
      box.classList.toggle('prs-complete', !!due && viewed === due);
      box.innerHTML = !due ? '' : viewed === due
        ? `<span class="prs-done">✓ All ${due} files marked viewed</span>`
        : `<b>${viewed} of ${due}</b> files marked viewed${left.length ? ` · ${left.map(chName).join(', ')} still ${left.length > 1 ? 'have' : 'has'} some to go` : ''}`;
      return;
    }
    const p = all[state.n - 1];
    // ticking the last of a chapter's files counts as reading it (only a change seen here, not a chapter already complete on load)
    const complete = !!(p && p.due && p.viewed === p.due);
    if (complete && completeSeen.get(state.n) === false) sendRead(state.n, 'viewed');
    completeSeen.set(state.n, complete);
    if (!p || !p.due) { box.innerHTML = '<span>Nothing to mark viewed in this chapter</span>'; return; }
    if (p.viewed === p.due) { box.classList.add('prs-complete'); box.innerHTML = `<span class="prs-done">✓ All ${p.due} marked viewed</span>`; return; }
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
      ? (chs.length ? `story chapter${chs.length > 1 ? 's' : ''} ${chList(chs)}` : '')
      : n === 0
        ? `chapter${chs.length > 1 ? 's' : ''} ${chList(chs)}`
        : `${st ? st.text : ''}${f.partial && st && st.kind !== 'later' && f.note ? ` (here: ${f.note})` : ''}`;
    // a file this chapter finishes: renderViewed swaps "Mark viewed" for "Viewed ✓" while its Viewed toggle is on
    const markRest = !inBackstory() && n && st && st.kind === 'mark' ? why.slice(st.text.length) : null;
    const markAttrs = markRest != null ? ` data-mark-for="${esc(f.rel)}" data-mark-rest="${esc(markRest)}"` : '';
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
      + `${why ? `<span class="prs-why${st ? ` prs-st-${st.kind}` : ''}"${markAttrs}>${esc(why)}</span>` : ''}${lines ? `<ul class="prs-lines">${lines}</ul>` : ''}${whyBox}</li>`;
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

  /** At the top of a "Since you read it" chapter: which commits it covers, and that the rest is as he read it. */
  function sinceBanner(ch) {
    if (!ch || !ch.since) return '';
    const n = ch.since.commits;
    const what = `${n != null ? `${n} commit${n === 1 ? '' : 's'}` : 'The commits'} since you read the story`;
    const rest = DATA.chapters.some((c) => !c.since) ? ' The chapters after this one are as you read them.' : '';
    // GitHub's diff of just these commits (the filter here shows the files they touched, but each file's whole PR diff)
    const url = HOST === 'GitHub' ? rangeUrl(DATA.pr && DATA.pr.url, ch.since) : null;
    const here = url && rangeStepOf([ch], location.pathname) === 1;
    const link = !url ? '' : here
      ? ` You're on GitHub's diff of just these commits. <a href="${esc(`${DATA.pr.url}/files`)}">All of the PR's changes</a>`
      : ` <a href="${esc(url)}" title="GitHub's Files changed for ${esc(sha7(ch.since.from))}..${esc(sha7(ch.since.to))} only">See just these commits' changes on GitHub</a>`;
    return `<div class="prs-since"><b>${esc(what)}</b>, ${esc(sha7(ch.since.from))}..${esc(sha7(ch.since.to))}. This step shows only the files they touched.${esc(rest)}${link}</div>`;
  }

  /** One drafted comment, with its step and index: renderDrafts adds its state and its buttons. */
  function commentHtml(c, n, i) {
    const general = !c.line || /^\(/.test(c.path || '');
    const ref = !general && resolveRef(c.path);
    const name = ref ? `<code ${refAttrs(ref.rel, { side: c.side === 'L' ? 'L' : 'R', start: c.line, end: c.line })}>${esc(c.path)}:${esc(c.line)}</code>` : `<code>${esc(c.path)}${general ? '' : `:${esc(c.line)}`}</code>`;
    const where = general ? 'General PR comment' : `On ${name}`;
    return `<div class="prs-comment" data-n="${n}" data-i="${i}"><div class="prs-where"><span>${where}</span><span class="prs-cbtns"><button class="prs-copy">Copy</button></span></div><pre>${esc(c.body)}</pre><div class="prs-cstate" hidden></div></div>`;
  }
  const ALL_COMMENTS_OPEN = 4; // more drafts than this and the Overview's list starts folded
  /** The Overview's list of every chapter's drafted comments, grouped by chapter, each with its chapter's actions. */
  function allCommentsHtml() {
    const groups = DATA.chapters.map((ch, k) => ({ n: k + 1, ch, cs: ch.comments || [] })).filter((g) => g.cs.length);
    const total = groups.reduce((a, g) => a + g.cs.length, 0);
    if (!total) return '';
    const items = groups.map((g) => `<div class="prs-cgroup" data-group="${g.n}"><h3 class="prs-cgh"><button class="prs-linkish" data-goto="${g.n}">${esc(cap(chName(g.n)))}</button>: ${esc(String(g.ch.title || '').replace(/^Chapter \d+:\s*/, ''))}</h3>`
      + `${g.cs.map((c, i) => commentHtml(c, g.n, i)).join('')}</div>`).join('');
    const open = state.allCommentsOpen != null ? state.allCommentsOpen : total <= ALL_COMMENTS_OPEN;
    return `<details class="prs-drafts prs-allc"${open ? ' open' : ''}><summary><h2 class="prs-h">${esc(COMMENTS_TITLE)}: all chapters (${total}) <span class="prs-draftsum"></span></h2></summary>`
      + `<div class="prs-drafttoggles"></div>${items}</details>`;
  }

  function renderBody() {
    const ch = chapter();
    const bsv = inBackstory();
    const list = steps();
    const stepList = [`<li data-n="0" class="${state.n === 0 ? 'prs-current' : ''}">${bsv ? 'How it got here' : 'Overview'} <span class="prs-count">(${DATA.files.length})</span></li>`]
      .concat(list.map((c, i) => `<li data-n="${i + 1}" class="${i + 1 === state.n ? 'prs-current' : ''}">${bsv ? '' : isNew(i + 1) ? '<span class="prs-new">New</span> ' : `${chNo(i + 1)}. `}${esc(c.title.replace(/^Chapter \d+:\s*/, ''))} <span class="prs-count">(${c.files.length})</span>${bsv ? '' : `<span class="prs-stepprog" data-prog-for="${i + 1}"></span>`}</li>`)).join('');
    $('.prs-title').textContent = bsv ? `Backstory: ${ch ? ch.title.replace(/^\d+\.\s*/, '') : 'how it got here'}` : ch ? ch.title : `Overview: ${DATA.pr.title || ''}`;
    $('.prs-title').title = $('.prs-title').textContent;
    $('.prs-prev').disabled = state.n === 0;
    $('.prs-next').disabled = state.n === list.length;
    pilled = new Set();
    lastRef = null;
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
      body = `<div class="prs-md">${intro}</div>${bsTop}${allCommentsHtml()}${filesBox(`All files (${DATA.files.length})`, `${DATA.chapters.length} chapters`, files)}`;
    } else {
      linkScope = ch.files.map((f) => f.rel);
      const story = storyWithPills(() => (ch.narrative
        ? markdown(ch.narrative)
        : `${ch.headline ? `<p><strong>${inline(ch.headline)}</strong></p>` : ''}${ch.scenario ? `<p>The scenario: ${inline(ch.scenario)}</p>` : ''}${ch.summary ? `<p>${inline(ch.summary)}</p>` : ''}<p class="prs-empty">This chapter's story isn't written yet.</p>`));
      const comments = (ch.comments || []).map((c, i) => commentHtml(c, state.n, i)).join('');
      const files = ch.files.map((f) => fileItem(f, state.n)).join('');
      body = `${sinceBanner(ch)}<div class="prs-md">${story}</div>${backstoryBlock(ch.backstory)}
        ${comments ? `<div class="prs-drafts"><h2 class="prs-h">${esc(COMMENTS_TITLE)} <span class="prs-draftsum"></span></h2><div class="prs-drafttoggles"></div>${comments}</div>` : ''}
        ${filesBox(`Files in this chapter (${ch.files.length})`, filesSummary(state.n), files)}`;
    }
    $('.prs-body').innerHTML = `<h2 class="prs-h">${bsv ? 'Backstory steps' : 'Steps'}</h2><ol class="prs-map">${stepList}</ol>${body}<div class="prs-questions"></div>`;
    if (!bsv) {
      // the viewed tracker sits right under the chapter's (or the Overview's) first heading
      const md = $('.prs-body .prs-md');
      const holder = document.createElement('div');
      holder.innerHTML = '<div class="prs-progress" aria-live="polite"></div><div class="prs-early-box" role="status"></div>';
      const head = md && md.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
      if (head) head.after(...holder.childNodes);
      else if (md) md.prepend(...holder.childNodes);
    }
    const cbox = $('.prs-body details.prs-allc');
    if (cbox) cbox.addEventListener('toggle', () => { state.allCommentsOpen = cbox.open; });
    const fbox = $('.prs-body details.prs-filesbox');
    if (fbox) fbox.addEventListener('toggle', () => { if (state.filesOpen !== fbox.open) { state.filesOpen = fbox.open; saveState(); } });
    renderQuestions();
    renderViewed();
    refreshDrafts(false);
    renderFresh();
    renderReads();
    $('.prs-body').scrollTop = 0;
  }

  // one click handler for everything in the panel body
  $('.prs-body').addEventListener('click', (e) => {
    const step = e.target.closest('ol.prs-map li[data-n]');
    if (step) return go(Number(step.getAttribute('data-n')));
    const copyBtn = e.target.closest('.prs-copy');
    if (copyBtn) { const el = copyBtn.closest('.prs-comment'); return copy(DATA.chapters[Number(el.getAttribute('data-n')) - 1].comments[Number(el.getAttribute('data-i'))].body, copyBtn); }
    const gotoBtn = e.target.closest('[data-goto]');
    if (gotoBtn) return go(Number(gotoBtn.getAttribute('data-goto')));
    if (e.target.closest('[data-draft-reload]')) return reloadPage();
    const actBtn = e.target.closest('[data-draft-act]');
    if (actBtn) { const el = actBtn.closest('.prs-comment'); return draftAct(Number(el.getAttribute('data-n')), Number(el.getAttribute('data-i')), actBtn.getAttribute('data-draft-act')); }
    const showBtn = e.target.closest('[data-draft-show]');
    if (showBtn) {
      const k = showBtn.getAttribute('data-draft-show');
      state[k] = !state[k];
      saveState();
      return renderDrafts();
    }
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
    readLeave();
    const keep = state.n;
    state.view = next;
    state.n = clampN(state.other, next);
    state.other = keep;
    state.all = false;
    readStart();
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
    if (n !== from) readLeave();
    state.n = n;
    state.all = false;
    if (n !== from) readStart();
    message('');
    saveState();
    renderBody();
    apply();
    reportPosition();
    if (n === 0) window.scrollTo({ top: 0 });
    else if (chapter().files[0]) scrollToFile(chapter().files[0].rel, true);
    if (left.length) message(`${cap(chName(from))} still has ${left.length} to mark viewed: ${left.map(short).join(', ')}. No rush: Prev goes back, or tick them later.`);
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
    if (opts.reveal) opts.reveal(rel, side, startLine, endLine || startLine);
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

  /** Copies the listen prompt; if the clipboard says no, shows it selected so Cmd+C works. */
  function copyPrompt(text, btn, pre) {
    const done = (ok) => {
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      if (!ok && pre) {
        pre.textContent = text;
        pre.hidden = false;
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setTimeout(() => { btn.textContent = 'Copy prompt for Claude'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
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
    message(`${rel.split('/').pop()} isn't in this chapter${where.length ? ` (it's in ${where.map(chName).join(', ')})` : ''}, and there's no chapter file past it.`);
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
    return { level: !listening || (h.story && !h.story.ok) ? 'warn' : 'ok', checks, listening, prompt: l.prompt || null, details: l.details || null, repo: l.repo || null, checkout: l.checkout || null };
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
      const html = res.level === 'error'
        ? `${esc(res.checks[0].detail)}. Questions can't be sent until it's back.`
        : res.prompt
          ? `No Claude session is listening${res.repo ? ` for ${esc(res.repo)}` : ''}; questions will wait. `
            + `${res.checkout ? `Start Claude Code in <code>${esc(res.checkout)}</code> and paste` : 'Paste into Claude Code'} <code>${esc(res.prompt)}</code> `
            + '<button type="button" class="prs-copyprompt">Copy prompt for Claude</button>'
            + (res.details ? ' <button type="button" class="prs-promptmore" aria-expanded="false">show details</button>' : '')
            + `<pre class="prs-prompt" hidden></pre>${res.details ? `<pre class="prs-promptlong" hidden>Without the diff-story-listen skill, paste this instead:\n${esc(res.details)}</pre>` : ''}`
          : 'No Claude session is listening; questions will wait. Start one in Claude Code as a background task: <code>diff-story wait --consumer pr-story</code>';
      // redrawn every 10s, so only when it changes (a "Copied" label stays put)
      if (hint.getAttribute('data-html') !== html) {
        hint.setAttribute('data-html', html);
        hint.innerHTML = html;
        const btn = hint.querySelector('.prs-copyprompt');
        if (btn) btn.onclick = () => copyPrompt(res.prompt, btn, hint.querySelector('.prs-prompt'));
        const more = hint.querySelector('.prs-promptmore');
        if (more) more.onclick = () => {
          const long = hint.querySelector('.prs-promptlong');
          long.hidden = !long.hidden;
          more.setAttribute('aria-expanded', String(!long.hidden));
          more.textContent = long.hidden ? 'show details' : 'hide details';
        };
      }
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

  // ---------- is the story up to date with the PR's latest commit?
  let fresh = null;
  let freshTimer = 0;
  async function refreshFresh() {
    if (!opts.freshness) return;
    try { fresh = await opts.freshness(); } catch (e) { fresh = { state: 'unknown', error: e && e.message }; }
    renderFresh();
  }
  function renderFresh() {
    const box = $('.prs-fresh');
    for (const el of panel.querySelectorAll('.prs-changed, .prs-touched')) el.remove();
    box.classList.remove('prs-stale');
    if (!fresh || fresh.state === 'n/a') { box.innerHTML = ''; return; }
    if (fresh.state === 'current') { box.innerHTML = updatedHtml(fresh) || `<span class="prs-why">Up to date with ${esc(sha7(fresh.story_head))}</span>`; markUpdated(fresh.updated); return; }
    if (fresh.state === 'unknown') { box.innerHTML = fresh.error ? `<span class="prs-why" title="${esc(fresh.error)}">Can't tell whether the story is up to date</span>` : ''; return; }
    box.classList.add('prs-stale');
    const n = fresh.newer;
    const what = fresh.rewritten ? 'the PR was rebased or force-pushed since' : n != null ? `the PR has ${n} newer commit${n === 1 ? '' : 's'}` : 'the PR has newer commits';
    const files = (fresh.changed_files || []).length;
    const touched = fresh.chapters_touched || [];
    box.innerHTML = `Story is for ${esc(sha7(fresh.story_head))}; ${what}${files ? ` (${files} file${files === 1 ? '' : 's'} changed${touched.length ? `, in ${touched.map(chName).join(', ')}` : ''})` : ''}.`
      + (opts.requestUpdate
        ? `<button class="prs-update" data-retell="0" title="Adds a “Since you read it” chapter for the new commits, first, and keeps the chapters you read">Update (new commits)</button>`
          + `<button class="prs-update" data-retell="1" title="A whole new story at the latest commit, for a rebase or a big rework">Re-tell from scratch</button>`
          + (fresh.rewritten ? '<span class="prs-why">It was rebased, so a re-tell is likely the better fit.</span>' : '')
        : '');
    for (const upd of box.querySelectorAll('.prs-update')) upd.onclick = async () => {
      const retell = upd.getAttribute('data-retell') === '1';
      for (const b of box.querySelectorAll('.prs-update')) b.disabled = true;
      try {
        await opts.requestUpdate(fresh.story_head, { retell });
        upd.textContent = retell ? 'Re-tell asked for' : 'Update asked for';
        message(retell ? 'Asked for a new story from scratch. A Claude session picks it up from the inbox.' : 'Asked for a “Since you read it” chapter for the new commits. A Claude session picks it up from the inbox.');
      } catch (e) {
        for (const b of box.querySelectorAll('.prs-update')) b.disabled = false;
        message(`Couldn't ask for an update: ${e && e.message ? e.message : e}`);
      }
    };
    // mark what changed since the story: the files, and the chapters that list them
    const changed = new Set(fresh.changed_files || []);
    for (const li of panel.querySelectorAll('ul.prs-files > li[data-file]')) {
      if (changed.has(li.getAttribute('data-file'))) li.querySelector('code').insertAdjacentHTML('afterend', '<span class="prs-changed" title="Changed in a commit after the one the story was told from">changed since story</span>');
    }
    if (!inBackstory()) for (const li of panel.querySelectorAll('ol.prs-map li[data-n]')) {
      if ((fresh.chapters_touched || []).includes(Number(li.getAttribute('data-n')))) li.insertAdjacentHTML('beforeend', '<span class="prs-touched" title="A file here changed after the story was told">• changed since</span>');
    }
  }
  /**
   * A story updated in place (no "Since you read it" chapter for the update): say so at the top, with what the new
   * commits changed and a link to GitHub's diff of just them, so what's new stays apart from what he'd seen.
   */
  function updatedHtml(f) {
    const u = f && f.updated;
    if (!u) return '';
    const n = u.newer;
    const commits = n != null ? `${n} new commit${n === 1 ? '' : 's'}` : 'New commits';
    const files = (u.changed_files || []).length;
    const touched = u.chapters_touched || [];
    const url = HOST === 'GitHub' ? rangeUrl(DATA.pr && DATA.pr.url, u) : null;
    const how = u.retold ? 're-told from scratch' : 'updated in place, with no “Since you read it” chapter';
    return `<b>${esc(commits)} since ${esc(sha7(u.from))}</b>: the story was ${how}${files ? `. They changed ${files} file${files === 1 ? '' : 's'}${touched.length ? `, in ${touched.map(chName).join(', ')}` : ''}` : ''}.`
      + (url ? ` <a href="${esc(url)}" title="GitHub's Files changed for ${esc(sha7(u.from))}..${esc(sha7(u.to))} only">See just what's new on GitHub</a>` : '')
      + ` <span class="prs-why">Up to date with ${esc(sha7(f.story_head))}</span>`;
  }
  function markUpdated(u) {
    if (!u) return;
    const changed = new Set(u.changed_files || []);
    for (const li of panel.querySelectorAll('ul.prs-files > li[data-file]')) {
      if (changed.has(li.getAttribute('data-file'))) li.querySelector('code').insertAdjacentHTML('afterend', `<span class="prs-changed" title="Changed in ${esc(sha7(u.from))}..${esc(sha7(u.to))}, the commits the last update brought in">new since ${esc(sha7(u.from))}</span>`);
    }
    if (!inBackstory()) for (const li of panel.querySelectorAll('ol.prs-map li[data-n]')) {
      if ((u.chapters_touched || []).includes(Number(li.getAttribute('data-n')))) li.insertAdjacentHTML('beforeend', `<span class="prs-touched" title="A file here changed in ${esc(sha7(u.from))}..${esc(sha7(u.to))}, the commits the last update brought in">• updated</span>`);
    }
  }
  if (opts.freshness || opts.reads) freshTimer = setInterval(() => { if (document.visibilityState === 'visible') { refreshFresh(); refreshReads(); } }, 60000);

  // ---------- chapters he read that changed after he read them (the bridge compares the commit he read them at with the story's)
  let readInfo = null;
  async function refreshReads() {
    if (!opts.reads) return;
    try { readInfo = await opts.reads(); } catch (e) { return; } // the bridge may be down; the marks just don't show
    renderReads();
    renderViewed(); // "viewed early" depends on which chapters he's read
    renderDrafts();
  }
  function renderReads() {
    for (const el of panel.querySelectorAll('.prs-readchg')) el.remove();
    if (!readInfo || inBackstory()) return;
    const by = new Map((readInfo.changed || []).map((c) => [c.step, c]));
    for (const li of panel.querySelectorAll('ol.prs-map li[data-n]')) {
      const c = by.get(Number(li.getAttribute('data-n')));
      if (c) li.insertAdjacentHTML('beforeend', `<span class="prs-readchg" title="${esc(`Changed after you read it (at ${sha7(c.since)}): ${c.files.join(', ')}`)}">• changed since you read</span>`);
    }
    const here = state.n && by.get(state.n);
    if (here) for (const li of panel.querySelectorAll('ul.prs-files > li[data-file]')) {
      if (here.files.includes(li.getAttribute('data-file'))) li.querySelector('code').insertAdjacentHTML('afterend', `<span class="prs-readchg" title="A newer commit changed it after you read this chapter at ${esc(sha7(here.since))}">changed since you read</span>`);
    }
  }
  const staleDraft = (n, i) => !!readInfo && (readInfo.stale_comments || []).some((c) => c.step === n && c.index === i);

  // ---------- drafted comments: posted, in his pending review, dismissed, or still a draft
  let draftRows = [];
  let draftError = null;
  let draftsAt = 0;
  async function refreshDrafts(force) {
    if (!opts.drafts || inBackstory()) return;
    if (!force && Date.now() - draftsAt < 10000) return renderDrafts();
    draftsAt = Date.now();
    try { const r = await opts.drafts.load(); draftRows = r.drafts || []; draftError = r.error || null; } catch (e) { draftError = e && e.message; }
    renderDrafts();
  }
  const rowKey = (n, i) => { const r = draftRows.find((x) => x.chapter === n && x.index === i); return r && r.key ? r.key : `${n}:${i}`; };
  async function draftAct(n, i, action) {
    const btn = action === 'review' && $(`.prs-comment[data-n="${n}"][data-i="${i}"] [data-draft-act="review"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    const key = rowKey(n, i);
    try {
      const r = await opts.drafts.act(n, i, action);
      draftRows = r.drafts || draftRows; draftError = r.error || null; draftsAt = Date.now();
      if (action === 'review') reviewErrors.delete(key);
      if (action === 'review' && r.added) message(`Added to your pending review${r.added.started ? ' (started a new one)' : ''}. Nobody else sees it until you submit the review.`);
    } catch (e) {
      const why = e && e.message ? e.message : String(e);
      if (action === 'review') reviewErrors.set(key, why); // shown on the draft, which keeps its buttons
      else message(`Couldn't save that: ${why}`);
    }
    renderDrafts();
  }
  function reloadPage() {
    if (opts.reloadPage) opts.reloadPage();
  }
  /** Is this line draft's comment on the page yet? Read only: it looks for its text in the file's comments. */
  function commentOnPage(c) {
    if (!c || !c.path || !(Number(c.line) > 0)) return false;
    const ref = resolveRef(c.path);
    const block = ref && blockOf(ref.rel);
    if (!block) return false;
    const texts = [...block.el.querySelectorAll('.comment-body, .js-comment-body, .markdown-body, [data-testid="markdown-body"]')].map((el) => el.textContent);
    return shownIn(texts, c.body);
  }
  function renderDrafts() {
    const box = $('.prs-drafts');
    if (!box || inBackstory()) return;
    const overview = !state.n; // the Overview lists every chapter's drafts
    const rows = draftRows.filter((r) => (overview ? DATA.chapters[r.chapter - 1] && (DATA.chapters[r.chapter - 1].comments || [])[r.index] : r.chapter === state.n));
    const by = new Map(rows.map((r) => [`${r.chapter}:${r.index}`, r]));
    let posted = 0; let pending = 0; let dismissed = 0;
    for (const el of box.querySelectorAll('.prs-comment[data-i]')) {
      const n = Number(el.getAttribute('data-n'));
      const i = Number(el.getAttribute('data-i'));
      const r = by.get(`${n}:${i}`) || { status: 'draft', dismissed: false };
      const c = ((DATA.chapters[n - 1] || {}).comments || [])[i];
      const v = draftView(r, { pageAt: PAGE_AT, onPage: !!r.added && commentOnPage(c) });
      if (v.settle && r.key && !settling.has(r.key) && opts.drafts) {
        settling.add(r.key);
        opts.drafts.act(n, i, 'settle').then((x) => { draftRows = x.drafts || draftRows; renderDrafts(); }, () => settling.delete(r.key));
      }
      const st = el.querySelector('.prs-cstate');
      const btns = el.querySelector('.prs-cbtns');
      for (const b of btns.querySelectorAll('[data-draft-act]')) b.remove();
      el.classList.remove('prs-c-done', 'prs-c-pending');
      el.hidden = false;
      st.hidden = true;
      const link = r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">view on GitHub</a>` : '';
      const add = (act, label, title) => btns.insertAdjacentHTML('afterbegin', `<button data-draft-act="${act}" title="${esc(title)}">${label}</button>`);
      if (v.show === 'dismissed') {
        dismissed++;
        el.classList.add('prs-c-done');
        el.hidden = !state.showDismissed;
        st.hidden = false;
        st.innerHTML = 'Dismissed. It won\'t be suggested again for this PR.';
        add('restore', 'Restore', 'Bring this draft back');
      } else if (v.show === 'posted') {
        posted++;
        el.classList.add('prs-c-done');
        el.hidden = !state.showPosted;
        st.hidden = false;
        st.innerHTML = `<span class="prs-ok">Posted ✓</span>${r.source === 'manual' ? ' (you marked it)' : ''}${link}`;
        add('unposted', 'Unmark', r.source === 'manual' ? 'Mark it as not posted' : 'Not the same comment? Show it as a draft again');
      } else if (v.show === 'pending') {
        pending++;
        el.classList.add('prs-c-done', 'prs-c-pending');
        st.hidden = false;
        st.innerHTML = `<span class="prs-pend">In your pending review</span>, not submitted yet${link || (r.added && r.added.url ? ` · <a href="${esc(r.added.url)}" target="_blank" rel="noopener noreferrer">view on GitHub</a>` : '')}`;
      } else if (v.show === 'added') {
        // Add to my review worked, but this page won't show the comment until it's reloaded
        pending++;
        el.classList.add('prs-c-done', 'prs-c-pending');
        st.hidden = false;
        const ref = c && resolveRef(c.path);
        const jump = ref ? ` · <button class="prs-linkish" ${refAttrs(ref.rel, { side: c.side === 'L' ? 'L' : 'R', start: Number(c.line), end: Number(c.line) })}>Jump to line ${esc(c.line)}</button>` : '';
        const gh = r.added.url ? ` · <a href="${esc(r.added.url)}" target="_blank" rel="noopener noreferrer">view on GitHub</a>` : '';
        const reload = opts.reloadPage ? ' <button class="prs-linkish" data-draft-reload title="Reloads this page. The panel stays on this chapter.">Reload page</button>' : '';
        st.innerHTML = `<span class="prs-pend">In your pending review</span>, on ${esc(c ? c.path : '')} line ${esc(c ? c.line : '')}${jump}${gh}`
          + `<span class="prs-cnote">GitHub shows it after a reload.${reload}</span>`;
      } else {
        if (staleDraft(n, i)) { st.hidden = false; st.innerHTML = '<span class="prs-cstale">May be out of date: a newer commit changed this line after you read the chapter.</span>'; }
        else if (overview) { st.hidden = false; st.innerHTML = '<span class="prs-cdraft">Draft</span>, not posted'; }
        add('dismiss', 'Dismiss', 'Not a comment you want: hide it, and don\'t suggest it again');
        add('posted', 'Mark posted', 'You posted this (or your own version of it)');
        if (HOST === 'GitHub' && c && c.path && Number(c.line) > 0) {
          add('review', 'Add to my review', 'Adds it to your pending review on GitHub. Only you can see it until you submit the review yourself.');
          const err = reviewErrors.get(r.key || `${n}:${i}`);
          if (err) { st.hidden = false; st.innerHTML = `<span class="prs-cerr">${esc(err)}</span>`; }
        }
      }
    }
    const left = rows.length ? rows.length - posted - pending - dismissed : box.querySelectorAll('.prs-comment[data-i]').length;
    box.querySelector('.prs-draftsum').textContent = rows.length ? `(${[`${left} to post`, posted && `${posted} posted`, pending && `${pending} pending`, dismissed && `${dismissed} dismissed`].filter(Boolean).join(' · ')})` : '';
    box.querySelector('.prs-drafttoggles').innerHTML = [
      posted ? `<button class="prs-linkish" data-draft-show="showPosted">${state.showPosted ? 'Hide' : 'Show'} posted (${posted})</button>` : '',
      dismissed ? `<button class="prs-linkish" data-draft-show="showDismissed">${state.showDismissed ? 'Hide' : 'Show'} dismissed (${dismissed})</button>` : '',
      draftError ? `<span class="prs-why" title="${esc(draftError)}">Couldn't check GitHub for posted comments; Mark posted still works.</span>` : '',
    ].filter(Boolean).join(' ');
  }
  let draftTimer = 0;
  if (opts.drafts) draftTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshDrafts(true); }, 60000);
  const onFocusDrafts = () => { refreshDrafts(true); refreshFresh(); refreshReads(); };
  window.addEventListener('focus', onFocusDrafts);

  // ---------- what Eric has read: a chapter he stayed on for READ_MS (while the tab showed), or ticked every file of
  const READ_AFTER = Number.isFinite(opts.readAfterMs) ? opts.readAfterMs : READ_MS;
  const readSent = new Set(); // "<key> <reason>": each at most once per panel
  const completeSeen = new Map(); // chapter -> were all its files viewed when last looked at
  const firstLook = new Map(); // chapter -> were all its files already viewed the first time the page showed them all (inferReadSteps)
  let readClock = { n: 0, ms: 0, from: 0 };
  const showing = () => document.visibilityState === 'visible';
  function readStart() { readClock = { n: inBackstory() ? 0 : state.n, ms: 0, from: showing() ? Date.now() : 0 }; }
  const readElapsed = () => readClock.ms + (readClock.from ? Date.now() - readClock.from : 0);
  function sendRead(n, reason) {
    const ch = DATA.chapters[n - 1];
    if (!opts.onRead || !ch) return;
    const key = chapterKeyOf(ch);
    const once = `${key} ${reason}`;
    if (readSent.has(once)) return;
    readSent.add(once);
    const head = DATA.kind === 'local' ? null : (fresh && fresh.current_head) || null; // the bridge asks gh when the panel doesn't know
    const seconds = reason !== 'inferred' && readClock.n === n ? Math.round(readElapsed() / 1000) : null;
    try { Promise.resolve(opts.onRead({ chapter: key, step: n, title: ch.title, reason, seconds, head_sha: head })).then(refreshReads, () => readSent.delete(once)); } catch (e) { readSent.delete(once); }
  }
  function readLeave() { if (readClock.n > 0 && readElapsed() >= READ_AFTER) sendRead(readClock.n, 'time'); }
  // switching tabs stops the clock, and counts as leaving
  const onReadVisibility = () => {
    if (showing()) { if (!readClock.from) readClock.from = Date.now(); return; }
    readClock.ms = readElapsed();
    readClock.from = 0;
    readLeave();
  };
  document.addEventListener('visibilitychange', onReadVisibility);
  window.addEventListener('pagehide', readLeave);

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
    readLeave();
    document.removeEventListener('visibilitychange', onReadVisibility);
    window.removeEventListener('pagehide', readLeave);
    observer.disconnect();
    clearTimeout(pending);
    clearTimeout(msgTimer);
    clearTimeout(posTimer);
    clearTimeout(flashTimer);
    clearInterval(healthTimer);
    clearInterval(draftTimer);
    clearInterval(freshTimer);
    window.removeEventListener('focus', onFocusDrafts);
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
  if (Number.isFinite(init.bodyScroll)) $('.prs-body').scrollTop = init.bodyScroll; // a live redraw keeps your place
  refreshDrafts(true);
  refreshFresh();
  refreshReads();
  readStart();
  apply();
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  reportPosition();

  const api = {
    destroy, go, setView, apply, scrollToLine, scrollToFile, refreshQuestions, setCollapsed, state, data: INPUT, readLeave,
    get seen() { return seen; },
    get health() { return health; },
    get bodyScroll() { return $('.prs-body').scrollTop; },
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
