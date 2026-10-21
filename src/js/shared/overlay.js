/*
 * Diff Story Mode panel. Ported from the pr-story GitHub overlay
 * (skills/pr-story/bin/overlay.js), and loaded two ways:
 *   - by the extension's content script on a GitHub PR's /changes or /files page
 *   - by the bridge's local page (bridge/public/local.js), whose diff view uses
 *     the same DOM shapes as GitHub's /changes page
 *
 * It adds a side panel, hides other chapters' files with display:none and
 * scrolls the page. It never clicks the host page's comment, review or approve
 * controls, never submits the host page's forms and makes no network calls
 * itself. It clicks only two kinds of host control, and only on the reviewer's
 * own click in the panel:
 *   - expand controls, from a file or line link: the file's own expand toggle if
 *     it's collapsed (Viewed and large files collapse), "Load diff", then the hunk
 *     expanders until the line is on the page. GitHub fetches the lines with the
 *     page's own settings, so ?w=1 holds.
 *   - one file's own Viewed toggle, from that file's "Mark viewed" button (or its
 *     "Viewed ✓", which unticks it). One click, one file: nothing ticks Viewed on
 *     its own, on a step change, in bulk or for any other file. Saving the step, reporting position and sending
 * questions all go through callbacks the caller passes in `opts`, and the
 * caller decides where they go (the extension sends them to the bridge
 * through its service worker).
 *
 * The panel is split by job under ./panel/ (see the README's Code layout). This
 * module wires them together: each gets the shared `context` and reaches the
 * others through it at call time, so no module imports another's state.
 *
 * opts (all optional):
 *   initial        {n, all, collapsed, width, view, bn} to start from (a saved step; bn is the backstory view's step)
 *   onState(s)     called with {n, all, collapsed, width, view, bn} whenever they change
 *   onPosition(p)  called with {step, chapter, file} when the step or the file at the top of the screen changes (debounced)
 *   onClose()      called after the x button removes the panel
 *   ask(q)         send a question {text, step, chapter, file}; returns a Promise
 *   loadQuestions() returns a Promise of [{id, at, step, text, file, answers: [{at, text}]}]
 *   status()       returns a Promise of the bridge's /api/status ({bridge, story, listening});
 *                  it rejects with err.code 'down', 'token' or 'old' when the bridge can't say. Drives the status light.
 *   drafts         {load(), act(chapter, index, action)}: each returns a Promise of {drafts: [{chapter, index, status:
 *                  'draft'|'posted'|'pending', dismissed, url, added}], error}. action is posted, unposted, dismiss,
 *                  restore, review (Add to my review) or settle (an added draft has shown up, see draftView).
 *   reloadPage()   reloads the page, keeping the panel's step and scroll; offered on a draft just added to the review
 *   onFilter(f)    called after each filter pass with {n, view, all}; the local page folds other chapters' lines with it
 *   reveal(rel, side, start, end)  called before a jump to a file (rel only) or lines, so a page that folds files or lines can open them
 *   pageAt         when this page loaded, in ms (performance.timeOrigin); a draft added after it isn't on the page yet
 *   freshness()    returns a Promise of {state: 'current'|'stale'|'unknown'|'n/a', story_head, current_head, newer,
 *                  changed_files, chapters_touched, updated, error}: is the story up to date with the PR's latest commit?
 *                  updated ({from, to, newer, retold, changed_files, chapters_touched}) is a current story's last update
 *                  when it has no "Since you read it" chapter, so the panel can still say what's new
 *   requestUpdate(base_sha, {retell}) asks for the story to be updated from that commit (a build request, mode 'update'):
 *                  by default a "Since you read it" chapter for the new commits, or with retell a whole new story
 *   onRead(r)      called with {chapter (its key), step, title, reason: 'time'|'viewed'|'inferred', seconds, head_sha} when the reviewer
 *                  leaves a chapter they spent READ_MS on (counted while the tab shows), or ticks the last of its files viewed,
 *                  or ('inferred') the page already had all its files Viewed and read.json has no record of it
 *   readAfterMs    how long counts as reading a chapter (READ_MS, 30s)
 *   reads()        returns a Promise of the bridge's GET /read: {reads, since, changed: [{step, files}],
 *                  stale_comments: [{step, index}]}: what changed in chapters they read, after they read them
 *   host           name of the page that owns the diff, for messages ("GitHub")
 *   commentsTitle  heading for the chapter's drafted comments ("Draft comments")
 */

import { createStoryModel } from './panel/story-model.js';
import { createPanelState, clampStep, stateHelpers } from './panel/panel-state.js';
import { createShell } from './panel/shell.js';
import { createHostPage } from './panel/host-page.js';
import { createFileRefs } from './panel/file-refs.js';
import { createMarkdown } from './panel/markdown.js';
import { createBackstoryViews } from './panel/backstory-views.js';
import { createExpander } from './panel/expand.js';
import { createFilter } from './panel/filter.js';
import { createViewedTracker } from './panel/viewed.js';
import { createFileList } from './panel/file-list.js';
import { createScroller } from './panel/scroll.js';
import { createNavigation } from './panel/navigation.js';
import { createBody } from './panel/body.js';
import { createStatusLight } from './panel/status-light.js';
import { createFreshness } from './panel/freshness.js';
import { createReading } from './panel/reading.js';
import { createDrafts } from './panel/drafts.js';
import { createQuestions } from './panel/questions.js';

// the pure helpers the content script, the local page and the tests use
export { draftView, shownIn } from './panel/drafts.js';
export { chapterKeyOf, finishedInOf, chapterNumbers } from './panel/story-model.js';
export { READ_MS, inferReadSteps, readStepsOf } from './panel/reading.js';
export { placePills, pillMarker } from './panel/file-refs.js';
export { rangeOfPath, rangeStepOf, rangeUrl } from './panel/freshness.js';
export { expandDirOf, expandStep, EXPAND_ALL_FAR } from './panel/expand.js';

const HOST_ID = 'diff-story-panel'; // the element on the page; the panel itself lives in its shadow root
const PANEL_ID = 'dsm-panel';
const SLOW_POLL_MS = 60000;

export function storyOverlay(input, opts = {}) {
  if (window.__diffStoryOverlay) {
    window.__diffStoryOverlay.destroy();
  }
  const story = createStoryModel(input);
  const initial = opts.initial || {};
  const context = {
    hostId: HOST_ID,
    panelId: PANEL_ID,
    opts,
    story,
    state: createPanelState(story, initial),
    hostName: opts.host || 'GitHub',
    // when this page loaded: a draft added after it isn't on the page yet
    pageLoadedAt: Number.isFinite(opts.pageAt)
      ? opts.pageAt
      : (globalThis.performance && performance.timeOrigin) || Date.now(),
    commentsTitle: opts.commentsTitle || 'Draft comments',
    clampStep: (step, view) => clampStep(story, step, view),
  };
  Object.assign(context, stateHelpers(context));
  const { state } = context;

  // each module gets the context and reaches the others through it at call time
  context.page = createHostPage({
    shaToPath: story.shaToPath,
    pathToSha: story.pathToSha,
    allPaths: story.allPaths,
    hostId: HOST_ID,
    panelId: PANEL_ID,
  });
  context.shell = createShell(context);
  context.refs = createFileRefs(context);
  context.markdown = createMarkdown(context);
  context.backstory = createBackstoryViews(context);
  context.expander = createExpander(context);
  context.filter = createFilter(context);
  context.viewed = createViewedTracker(context);
  context.fileList = createFileList(context);
  context.scroll = createScroller(context);
  context.navigation = createNavigation(context);
  context.body = createBody(context);
  context.statusLight = createStatusLight(context);
  context.freshness = createFreshness(context);
  context.reading = createReading(context);
  context.drafts = createDrafts(context);
  context.questions = createQuestions(context);
  context.shell.isolateKeys();

  // the bridge's answers that more than one part shows: every minute, and when the tab gets focus again
  let slowPollTimer = 0;
  if (opts.freshness || opts.reads) {
    slowPollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        context.freshness.refresh();
        context.reading.refresh();
      }
    }, SLOW_POLL_MS);
  }
  const onFocus = () => {
    context.drafts.refresh(true);
    context.freshness.refresh();
    context.reading.refresh();
  };
  window.addEventListener('focus', onFocus);

  function destroy() {
    context.reading.leave();
    context.reading.destroy();
    context.filter.destroy();
    context.shell.clearMessageTimer();
    context.navigation.destroy();
    context.scroll.destroy();
    context.statusLight.destroy();
    context.drafts.destroy();
    clearInterval(slowPollTimer);
    window.removeEventListener('focus', onFocus);
    context.expander.cancel();
    context.questions.destroy();
    context.shell.stopResizing();
    context.filter.unhideAll();
    context.shell.unmount();
    context.viewed.destroy();
    if (window.__diffStoryOverlay === api) {
      delete window.__diffStoryOverlay;
    }
  }
  context.destroy = destroy;

  const { shell } = context;
  shell.mount();
  shell.setWidth(
    Number.isFinite(initial.width)
      ? state.width
      : Math.min(state.width, Math.round(window.innerWidth * 0.4)),
  );
  shell.setCollapsed(state.collapsed);
  context.body.render();
  if (Number.isFinite(initial.bodyScroll)) {
    shell.$('.prs-body').scrollTop = initial.bodyScroll; // a live redraw keeps your place
  }
  context.drafts.refresh(true);
  context.freshness.refresh();
  context.reading.refresh();
  context.reading.start();
  context.filter.apply();
  context.filter.watch();
  context.navigation.reportPosition();

  const api = {
    destroy,
    go: context.navigation.go,
    setView: context.navigation.setView,
    apply: context.filter.apply,
    scrollToLine: context.scroll.scrollToLine,
    scrollToFile: context.scroll.scrollToFile,
    jumpTo: context.scroll.jumpTo,
    refreshQuestions: context.questions.refresh,
    setCollapsed: shell.setCollapsed,
    state,
    data: input,
    readLeave: context.reading.leave,
    get seen() {
      return context.filter.seen;
    },
    get health() {
      return context.statusLight.current;
    },
    get bodyScroll() {
      return shell.$('.prs-body').scrollTop;
    },
    refreshHealth: context.statusLight.refresh,
    summary() {
      const stepCount = story.backstorySteps.length;
      const chapterCount = story.data.chapters.length;
      let label;
      if (context.inBackstory()) {
        label = state.n
          ? `backstory step ${state.n} of ${stepCount}`
          : `backstory overview (${stepCount} steps)`;
      } else {
        label = state.n
          ? `chapter ${state.n} of ${chapterCount}`
          : `overview (${chapterCount} chapters)`;
      }
      const seen = context.filter.seen;
      return `diff story: ${label}, ${seen.shown} of ${context.inChapter().size} files found on the page (${seen.found} file blocks seen, ${story.data.files.length} in the diff)`;
    },
  };
  window.__diffStoryOverlay = api;
  return api;
}
