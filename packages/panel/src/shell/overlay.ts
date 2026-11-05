/*
 * Once Upon a Diff panel. It started as the once-upon skill's GitHub overlay
 * snippet, since retired, and is loaded two ways:
 *   - by the extension's content script on a GitHub PR's /changes or /files page
 *   - by the bridge's local page (the bridge package's public/local.js), whose diff view uses
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
 * host is the app's side of the panel (host.ts): the diff page's adapter and the bridge's client. opts is what it does with the
 * panel's events, and bridgeOptions(host) (bridge-options.ts) fills in the calls every host makes the same way.
 *
 * opts:
 *   stylesheets    {page, panel, ui, tokens}: the URLs of the panel's page.css and panel.css (src/css/), ui-kit/ui.css and ui-kit/tokens.css as the host serves them (required)
 * and all optional:
 *   initial        {n, all, collapsed, width, chatOpen, chatHeight, ...} to start from (a saved step)
 *   onState(s)     called with {n, all, collapsed, width, chatOpen, chatHeight, ...} whenever they change
 *   onLayout(l)    called with {width} or {chatHeight} when the reader drags the panel's edge or the dock's top, so the
 *                  host can keep the size for every story (panel/shell/layout.ts)
 *   onPosition(p)  called with {step, chapter, file} when the step or the file at the top of the screen changes (debounced)
 *   onClose()      called after the x button removes the panel
 *   ask(q)         send a question {text, step, chapter, file}; returns a Promise
 *   loadQuestions() returns a Promise of [{id, at, step, text, file, dismissed, collapsed, handed_to, answers: [{at, text, by}]}]
 *   markQuestions(action, ids, extra) saves what the reviewer did with questions: dismiss, restore, collapse, expand,
 *                  read, unread, read_all, or clear (dismiss every one in the story); returns a Promise of
 *                  {questions, cleared}. A read's extra is {seen: {<question id>: newest answer `at` drawn}, auto}
 *   status()       returns a Promise of the bridge's /api/status ({bridge, story, listening});
 *                  it rejects with err.code 'down', 'token' or 'old' when the bridge can't say. Drives the status light.
 *   drafts         {load(), act(chapter, index, action)}: each returns a Promise of {drafts: [{chapter, index, status:
 *                  'draft'|'posted'|'pending', dismissed, url, added}], error}. action is dismiss, restore, review
 *                  (Add to my review), fix (Add to fix before push, on PR and local stories) or settle (an added draft has
 *                  shown up, see draftView).
 *   fixes          {load(), act(body), note(id, changes), onChange(view)}: fix before push (panel/fixes.js). load and act
 *                  (POST .../fixes {action: send|auto|take_back}) return a Promise of {notes, auto_send, to, requests};
 *                  note(id, {body} | {delete: true}) changes a draft note; onChange(view) is called when they change
 *   working()      returns a Promise of the bridge's GET /working ({marks: [{consumer, files: [{path, ranges}],
 *                  started_at, at}]}): the files a Claude session says it's changing, dimmed until it's done
 *   reloadPage()   reloads the page, keeping the panel's step and scroll; offered on a draft just added to the review
 *   pulse()        returns a Promise of the bridge's GET /pulse ({version, questions_rev, drafts_rev, fixes_rev, working_rev,
 *                  listening, answering}),
 *                  asked every 5s while the tab shows: the questions, drafts and status light look again only when
 *                  their part changed
 *   stillOpen()    called about once a minute while the tab is hidden (it makes no pulse then): the host tells the bridge the
 *                  story is still open, so a story listener doesn't stop for a reader with the tab in the background. It does
 *                  nothing else: freshness, position and the rest wait for the tab to show again
 *   onPulse(p)     called with each pulse, so the host can reload the story when its version moved
 *   onFilter(f)    called after each filter pass with {n, all}; the local page folds other chapters' lines with it
 *   reveal(rel, side, start, end)  called before a jump to a file (rel only) or lines, so a page that folds files or lines can open them
 *   freshness()    returns a Promise of {state: 'current'|'stale'|'unknown'|'n/a', story_head, current_head, newer,
 *                  changed_files, chapters_touched, updated, error}: is the story up to date with the PR's latest commit?
 *                  updated ({from, to, newer, retold, changed_files, chapters_touched}) is a current story's last update
 *                  when it has no "Since you read it" chapter, so the panel can still say what's new
 *   requestUpdate(base_sha, {retell}) asks for the story to be updated from that commit (a build request, mode 'update'):
 *                  by default a "Since you read it" chapter for the new commits, or with retell a whole new story
 *   requestRebuild({mode, from_step, guidance}) asks for the story to be told again (a build request, mode 'rebuild',
 *                  or 'rebuild_from' with from_step: chapters before it stay as they are); returns a Promise of
 *                  {rebuild}. The pulse's `rebuild` ({state, mode, from_step, requested_at, done_at, note}) says how it stands
 *   onRead(r)      called with {chapter (its key), step, title, reason: 'time'|'viewed'|'inferred', seconds, head_sha} when the reviewer
 *                  leaves a chapter they spent READ_MS on (counted while the tab shows), or ticks the last of its files viewed,
 *                  or ('inferred') the page already had all its files Viewed and read.json has no record of it
 *   reads()        returns a Promise of the bridge's GET /read: {reads, since, changed: [{step, files}],
 *                  stale_comments: [{step, index}]}: what changed in chapters they read, after they read them
 *   host           name of the page that owns the diff, for messages ("GitHub")
 *   commentsTitle  heading for the chapter's drafted comments ("Draft comments")
 */

import { createStoryModel } from '../state/story-model.ts';
import { createPanelState, stateHelpers } from '../state/panel-state.ts';
import { createShell } from './shell.ts';
import { createFileRefs } from '../components/file-refs.ts';
import { createMarkdown } from '../components/markdown.ts';
import { createExpander } from '../reading/expand.ts';
import { createFilter } from '../reading/filter.ts';
import { createViewedTracker } from '../reading/viewed.ts';
import { createFileList } from '../reading/file-list.ts';
import { createScroller } from '../reading/scroll.ts';
import { createNavigation } from '../reading/navigation.ts';
import { createBody } from './body.ts';
import { createStatusLight } from '../components/status-light-part.ts';
import { createMarkup } from '../components/markup.ts';
import { createFreshness } from '../rebuild/freshness-part.ts';
import { createRebuild } from '../rebuild/rebuild-part.ts';
import { createReading } from '../reading/reading.ts';
import { createMarks } from '../rebuild/marks.ts';
import { createDrafts } from '../drafts/drafts-part.ts';
import { createQuestions } from '../ask/questions.ts';
import { createChatDock } from '../ask/chat-dock.ts';
import { createFixes } from '../fixes/fixes-part.ts';
import { createWorking } from '../fixes/working.ts';
import { createPoll } from '@once-upon-a-diff/bridge-client/poll';
import type { Pulse, StoryData } from '@once-upon-a-diff/contracts/types';
import type { PanelContext, PanelOptions } from '../host/context.ts';
import type { PanelHost } from '../host/host.ts';

export type { PanelContext, PanelOptions } from '../host/context.ts';
export type { InitialUi } from '../state/initial-ui.ts';

// the pure helpers the content script, the local page and the tests use
export { draftView, shownIn } from '../drafts/drafts.ts';
export { fixSummary } from '../fixes/fixes.ts';
export { changingOf } from '../fixes/working.ts';
export { chapterKeyOf, finishedInOf, chapterNumbers } from '@once-upon-a-diff/domain/chapters';
export { READ_MS } from '../reading/reading.ts';
export { inferReadSteps, viewedEarlyCheck } from '../reading/read-checks.ts';
export { placePills, pillMarker } from '../components/file-refs.ts';
export { rangeOfPath, rangeStepOf, rangeUrl, requestLine } from '../rebuild/freshness.ts';
export { rebuildAsk, rebuildLine } from '../rebuild/rebuild.ts';
export { expandDirOf, expandStep, EXPAND_ALL_FAR } from '../reading/expand.ts';

const HOST_ID = 'once-upon-panel'; // the element on the page; the panel itself lives in its shadow root
const PANEL_ID = 'ou-panel'; // both are spelled out in panel/css/page.css and panel/css/panel.css
// the panel's one clock (a createPoll): a tick every 5s while the tab shows, with one pulse call. Without a pulse, questions take
// every tick while one waits for its answer (else every 6th) and the status light every 6th (30s). Drafts, freshness
// and reads look every 12th tick (a minute) either way.
const TICK_MS = 5000;
const STATUS_EVERY = 6;
const SLOW_EVERY = 12;
// a hidden tab doesn't tick, but its page is still open: opts.stillOpen says so about once a minute (a createPoll with whenHidden), and nothing else
const STILL_OPEN_MS = 60000;

/** A pulse, or {down: true} when the bridge didn't answer. */
type PulseLook = Partial<Pulse> & { down?: boolean };

export function storyOverlay(input: StoryData, opts: PanelOptions, host: PanelHost) {
  if (window.__onceUponOverlay) {
    window.__onceUponOverlay.destroy();
  }
  const story = createStoryModel(input);
  const initial = opts.initial || {};
  // the parts go on below, before any of them is called: each reaches the others through it at call time
  const context = {
    hostId: HOST_ID,
    panelId: PANEL_ID,
    opts,
    story,
    state: createPanelState(story, initial),
    hostName: opts.host || 'GitHub',
    // when this page loaded: a draft added after it isn't on the page yet
    pageLoadedAt: (globalThis.performance && performance.timeOrigin) || Date.now(),
    commentsTitle: opts.commentsTitle || 'Draft comments',
    count: (name) => host.count(name),
  } as PanelContext;
  Object.assign(context, stateHelpers(context));
  const { state } = context;

  // the previous pulse. The poll's first load is asked before the parts' first loads, so nothing that changes after them is missed.
  let last: PulseLook | null = null;
  let ticks = 0;
  let asked = false;
  let slowedOnFocus = false;
  const pulsePoll = createPoll<PulseLook | null>({
    everyMs: TICK_MS,
    // with no pulse there is nothing to load: the tick still runs, for the parts that look on their own share of them
    load: (signal) =>
      opts.pulse ? opts.pulse(signal).catch(() => ({ down: true })) : Promise.resolve(null),
    // a load the poll gave up on (timed out) has no pulse: it reads as down, like one the bridge didn't answer
    onChange: ({ data: pulse, error }) => {
      const data: PulseLook | null = error ? { down: true } : pulse;
      if (!asked) {
        asked = true; // the first load only sets the starting point
        if (data && !data.down) {
          last = data;
          context.rebuild?.update(data.rebuild);
          context.freshness?.setRequest(data.request);
        }
        return;
      }
      ticks++;
      beat(data);
      // a focus just ran slow(): the tick its pulse counts as doesn't run it again
      if (ticks % SLOW_EVERY === 0 && !slowedOnFocus) {
        slow();
      }
      slowedOnFocus = false;
    },
  });

  // each module gets the context and reaches the others through it at call time
  context.page = host.createPage({
    shaToPath: story.shaToPath,
    pathToSha: story.pathToSha,
    allPaths: story.allPaths,
    hostId: HOST_ID,
    panelId: PANEL_ID,
  });
  context.shell = createShell(context);
  context.refs = createFileRefs(context);
  context.markdown = createMarkdown(context);
  context.markup = createMarkup(context);
  context.expander = createExpander(context);
  context.filter = createFilter(context);
  context.viewed = createViewedTracker(context);
  context.fileList = createFileList(context);
  context.scroll = createScroller(context);
  context.navigation = createNavigation(context);
  context.body = createBody(context);
  context.statusLight = createStatusLight(context);
  context.freshness = createFreshness(context);
  context.rebuild = createRebuild(context);
  context.reading = createReading(context);
  context.marks = createMarks(context);
  context.drafts = createDrafts(context);
  context.fixes = createFixes(context);
  context.working = createWorking(context);
  context.chatDock = createChatDock(context);
  context.questions = createQuestions(context);
  context.shell.isolateKeys();
  // the parts are built (a constructor that throws leaves no poll behind), and the first pulse is asked before their first loads
  pulsePoll.start();

  // every part's look at the bridge, on the tick and when the tab gets focus again (a comment drafted or a session
  // started in the terminal shows up as soon as you come back). With opts.pulse, one cheap call a tick says which
  // parts changed; without it, each part looks on its own share of the ticks.
  const slow = () => {
    context.drafts.refresh(true); // GitHub's posted state isn't in the pulse
    if (!opts.pulse) {
      context.fixes.refresh();
      context.working.refresh();
    }
    context.freshness.refresh();
    context.reading.refresh();
  };
  function beat(pulse: PulseLook | null) {
    if (!pulse) {
      context.questions.poll(ticks);
      if (ticks % STATUS_EVERY === 0) {
        context.statusLight.refresh();
      }
      return;
    }
    const moved = (key: keyof PulseLook) => !!last && pulse[key] !== last[key];
    if (opts.onPulse && !pulse.down) {
      opts.onPulse(pulse as Pulse);
    }
    if (moved('questions_rev')) {
      context.questions.refresh();
    }
    if (moved('drafts_rev')) {
      context.drafts.refresh(true);
    }
    if (moved('fixes_rev')) {
      context.fixes.refresh();
    }
    if (moved('working_rev')) {
      context.working.refresh();
    }
    if (moved('listening') || moved('answering') || moved('agent') || moved('down')) {
      context.statusLight.refresh();
    }
    if (!pulse.down) {
      context.rebuild.update(pulse.rebuild);
      context.freshness.setRequest(pulse.request);
    }
    last = pulse;
  }
  // a hidden tab doesn't tick, but its page is still open
  const stillOpenPoll = opts.stillOpen
    ? createPoll<void>({
        everyMs: STILL_OPEN_MS,
        whenHidden: true,
        load: async (signal) => void (await opts.stillOpen!(signal)),
        onChange: () => {},
      })
    : null;
  stillOpenPoll?.start();
  // the poll's own focus load is the pulse; the parts that don't hang on a pulse look here
  const onFocus = () => {
    if (!opts.pulse) {
      context.questions.refresh();
      context.statusLight.refresh();
    }
    slow();
    slowedOnFocus = true;
  };
  window.addEventListener('focus', onFocus);

  function destroy() {
    context.reading.leave();
    context.reading.destroy();
    context.filter.destroy();
    context.shell.clearMessageTimer();
    context.questions.destroy();
    context.chatDock.destroy();
    context.working.destroy();
    context.drafts.destroy();
    context.navigation.destroy();
    context.scroll.destroy();
    pulsePoll.stop();
    stillOpenPoll?.stop();
    window.removeEventListener('focus', onFocus);
    context.expander.cancel();
    context.shell.stopResizing();
    context.filter.unhideAll();
    context.shell.unmount();
    context.viewed.destroy();
    if (window.__onceUponOverlay === api) {
      delete window.__onceUponOverlay;
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
  context.chatDock.setOpen(state.chatOpen);
  context.body.render();
  if (Number.isFinite(initial.bodyScroll)) {
    shell.$('.ou-body')!.scrollTop = initial.bodyScroll as number; // a live redraw keeps your place
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
    apply: context.filter.apply,
    scrollToLine: context.scroll.scrollToLine,
    scrollToFile: context.scroll.scrollToFile,
    jumpTo: context.scroll.jumpTo,
    refreshQuestions: context.questions.refresh,
    refreshFixes: context.fixes.refresh,
    sendFixes: context.fixes.sendNotes,
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
      return shell.$('.ou-body')!.scrollTop;
    },
    refreshHealth: context.statusLight.refresh,
    summary() {
      const chapterCount = story.data.chapters.length;
      const label = state.n
        ? `chapter ${state.n} of ${chapterCount}`
        : `overview (${chapterCount} chapters)`;
      const seen = context.filter.seen;
      return `Once Upon a Diff: ${label}, ${seen.shown} of ${context.inChapter().size} files found on the page (${seen.found} file blocks seen, ${story.data.files.length} in the diff)`;
    },
  };
  window.__onceUponOverlay = api;
  return api;
}

/** What storyOverlay returns: the panel on the page, for its host. */
export type StoryOverlay = ReturnType<typeof storyOverlay>;
