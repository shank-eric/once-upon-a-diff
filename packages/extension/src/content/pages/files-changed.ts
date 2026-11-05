/*
 * A GitHub PR's Files changed page (/changes or /files): asks the bridge
 * (through the service worker) whether there's a story for this PR and, if
 * so, docks the story panel. It re-applies the panel after a reload, after
 * GitHub's in-page navigation, and when the story on disk changes, starting
 * from the step saved for this PR. Whenever the panel isn't showing, the PR's
 * story tag sits by the title, as on the Conversation tab (pr-tags.ts):
 * Story opens the panel, Build story or Update asks for one. It also keeps
 * GitHub's Hide whitespace (?w=1) in step with the saved setting.
 *
 * It never clicks GitHub's controls, never submits GitHub's forms and makes no
 * network calls of its own: everything goes through the service worker to the
 * bridge on 127.0.0.1.
 */
import { storyOverlay, rangeStepOf } from '@once-upon-a-diff/panel/shell/overlay';
import { bridgeOptions } from '@once-upon-a-diff/panel/host/bridge-options';
import { createHostPage } from '@once-upon-a-diff/host-github/diff-dom';
import { filesChangedPr } from '@once-upon-a-diff/host-github/pages';
import { withLayout, type Layout } from '@once-upon-a-diff/panel/shell/layout';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { bridgeProblem } from '@once-upon-a-diff/api-client/client';
import { bridge, extensionAlive, usage } from '../bridge.ts';
import { createListenOption } from '../listen.ts';
import { loadPanelUi, savePanelUi, loadPrefsCopy, storePrefsCopy, tabSession } from '../storage.ts';
import { createPrTags, titleElement } from '../pr-tags.ts';
import { requestFor, stepOfHash, withAskDock } from '../tag-model.ts';
import { toast } from '../components/toast.ts';
import { createWhitespaceCheck, prefsStore } from './hide-whitespace.ts';
import type { BridgeAnswer } from '../bridge.ts';
import type { PanelUi } from '../storage.ts';
import type { PrRef } from '../tag-model.ts';
import type { Route } from '../index.ts';
import type { PanelOptions, StoryOverlay } from '@once-upon-a-diff/panel/shell/overlay';
import type { PanelHost } from '@once-upon-a-diff/panel/host/host';
import type { FilesChangedPr } from '@once-upon-a-diff/host-github/pages';
import type { StatusError, StoryData } from '@once-upon-a-diff/protocol/types';

/** The PR page on screen, and its story once the bridge has one. */
interface CurrentPage extends FilesChangedPr {
  pr: PrRef;
  id: string | null;
  version: string | null;
  data: StoryData | null;
  ui: PanelUi;
  overlay: StoryOverlay | null;
  status: string;
  /** why the bridge couldn't answer, when `status` is its failure's message (the code's word, not the message's) */
  problem?: StatusError['code'];
  /** the commit-range path whose chapter it opened on, once per page */
  rangeFor?: string;
  /** the #ou-step-N URL it opened on, once per page */
  hashFor?: string;
  /** the #ou-ask URL it opened the Ask dock for, once per page */
  askFor?: string;
}

const PANEL_ID = 'once-upon-panel';
const TAG_ATTR = 'data-ou-files';

const panelOnPage = () => !!document.getElementById(PANEL_ID);
const prOfLocation = () => filesChangedPr(location.pathname);
/** The bridge's answer body, or an Error with its message. */
async function bodyOf<T>(answerPromise: Promise<BridgeAnswer<T>>): Promise<T> {
  const answer = await answerPromise;
  if (!answer.ok) {
    throw new Error(answer.error as string);
  }
  return answer.body;
}

/** The panel's size across stories from the bridge's prefs.json, or null when the bridge doesn't answer (the PR's own saved size stands). */
async function bridgeLayout(): Promise<Layout | null> {
  const answer = await bridge.call(ROUTES.prefsRead);
  return answer.ok ? answer.body.layout || null : null;
}

export function createFilesChangedPage() {
  // one PR page at a time
  let current: CurrentPage | null = null;
  let syncing = false;
  const tags = createPrTags({ attr: TAG_ATTR, onStory: () => openPanel() });

  function unmount() {
    if (current && current.overlay) {
      current.overlay.destroy();
    }
    if (current) {
      current.overlay = null;
    }
  }

  /** The step to open on, once per page: a "Since you read it" range's chapter, or a #ou-step-N from a PR-list tag. */
  function jumpStep() {
    // only called with a story (mount). GitHub's diff of one "Since you read it" chapter's commits opens on that
    // chapter, once per page
    const range = rangeStepOf(current!.data!.chapters, location.pathname);
    if (range && current!.rangeFor !== location.pathname) {
      current!.rangeFor = location.pathname;
      return range;
    }
    // a PR-list "Story · 2 of 5 read" tag links Files changed#ou-step-N: open on the first unread chapter, once
    const hashStep = stepOfHash(location.hash);
    if (
      hashStep &&
      hashStep <= current!.data!.chapters.length &&
      current!.hashFor !== location.href
    ) {
      current!.hashFor = location.href;
      return hashStep;
    }
    return null;
  }

  /** The panel's host here: GitHub's diff DOM, and the bridge through the service worker. */
  function panelHost(storyId: string): PanelHost {
    return {
      createPage: createHostPage,
      client: bridge,
      storyId,
      pageUrl: () => location.href,
      count: usage.count,
    };
  }

  /** The panel's callbacks, all through the bridge. */
  function panelOptions(key: string, storyId: string): Omit<PanelOptions, 'initial'> {
    const params = { id: storyId };
    return {
      ...bridgeOptions(panelHost(storyId)),
      host: 'GitHub',
      stylesheets: {
        page: chrome.runtime.getURL('panel/page.css'),
        panel: chrome.runtime.getURL('panel/panel.css'),
        ui: chrome.runtime.getURL('ui/ui.css'),
      },
      onState: (panelState) => {
        if (!current || current.key !== key) {
          return;
        }
        current.ui = { ...panelState, hidden: false };
        savePanelUi(key, current.ui);
      },
      // a drag: the new size is every story's (prefs.json), here and on the local page
      onLayout: (layout) => {
        bridge.call(ROUTES.prefsWrite, { body: { layout } }).catch(() => {});
      },
      onClose: () => {
        if (!current || current.key !== key) {
          return;
        }
        current.overlay = null;
        current.ui = { ...current.ui, hidden: true };
        savePanelUi(key, current.ui);
        tagAfterPanel();
        toast(
          'Story hidden. Click the Once Upon a Diff toolbar button (or Alt+Shift+S) to bring it back.',
        );
      },
      ask: async (question) => {
        const answer = await bridge.call(ROUTES.questionAsk, {
          params,
          body: { ...question, url: location.href },
        });
        if (!answer.ok) {
          throw new Error(
            answer.error === 'unreachable' ? 'the bridge is not running' : (answer.error as string),
          );
        }
        return answer.body;
      },
      // only when the reviewer clicks Reload page
      reloadPage: async () => {
        await keepPanelPlace();
        location.reload();
      },
      freshness: () => bodyOf(bridge.call(ROUTES.storyFreshness, { params })),
      requestUpdate: (base, { retell = false }: { retell?: boolean } = {}) =>
        bodyOf(
          bridge.call(ROUTES.buildRequest, {
            body: requestFor({ act: 'update', base }, (current as CurrentPage).pr, { retell }),
          }),
        ),
      status: async () => {
        const answer = await bridge.call(ROUTES.status, { query: { story: storyId } });
        if (answer.ok) {
          return answer.body;
        }
        throw Object.assign(new Error(answer.error as string), { code: bridgeProblem(answer) });
      },
      // Start listening: type the listen line into an idle Claude Code session, through the bridge's board
      listen: createListenOption(bridge.call, storyId),
      // a hidden tab doesn't pulse: this keeps the story's listener from stopping while the page is still open
      stillOpen: () => bridge.call(ROUTES.storySeen, { params }),
      // the story changed on disk (Claude filled in a chapter): redraw in place
      onPulse: (pulse) => {
        if (current && current.key === key && pulse.version !== current.version) {
          checkForUpdates(pulse.version);
        }
      },
    };
  }

  function mount() {
    if (!current || !current.data || current.ui.hidden) {
      return;
    }
    if (current.overlay) {
      current.overlay.destroy();
    }
    const jump = jumpStep();
    // a PR-list "1 new answer" badge links Files changed#ou-ask: open the Ask dock, once per page
    const asked = withAskDock(current.ui, {
      hash: location.hash,
      href: location.href,
      opened: current.askFor,
    });
    current.askFor = asked.opened;
    const base = asked.panel;
    const storyId = current.id as string; // a story's page has its id
    current.overlay = storyOverlay(
      current.data,
      {
        initial: jump ? { ...base, n: jump, all: false } : base,
        ...panelOptions(current.key, storyId),
      },
      panelHost(storyId),
    );
  }

  async function fetchStory(id: string): Promise<StoryData | null> {
    const answer = await bridge.call(ROUTES.story, { params: { id } });
    return answer.ok ? answer.body : null;
  }

  /** Bring the page in line with the URL: mount, keep, or remove the panel. */
  async function sync() {
    if (syncing || !extensionAlive()) {
      return;
    }
    syncing = true;
    try {
      const pr = prOfLocation();
      if (!pr) {
        unmount();
        current = null;
        return;
      }
      if (current && current.key === pr.key) {
        // GitHub can swap out <body> on in-page navigation, which takes the panel with it
        if (current.data && !current.ui.hidden && (!current.overlay || !panelOnPage())) {
          mount();
        }
        return;
      }
      unmount();
      current = {
        ...pr,
        pr: { repo: `${pr.owner}/${pr.repo}`, number: pr.number },
        id: null,
        version: null,
        data: null,
        ui: {},
        overlay: null,
        status: 'loading',
      };
      const mine = current;
      const answer = await tags.look([current.pr], { force: true });
      if (current !== mine) {
        return;
      }
      if (!answer.ok) {
        current.status = answer.error || `HTTP ${answer.status}`;
        current.problem = bridgeProblem({ status: answer.status ?? 0, body: answer.body });
        return;
      }
      const result = tags.resultOf(current.pr);
      if (!result || result.state !== 'ready' || !result.story) {
        current.status = (result && result.state) || 'none'; // none, queued or building
        return;
      }
      const data = await fetchStory(result.story);
      if (current !== mine || !data) {
        return;
      }
      current.id = result.story;
      current.version = data.version;
      current.data = data;
      const [saved, layout] = await Promise.all([loadPanelUi(pr.key), bridgeLayout()]);
      current.ui = withLayout(saved, layout);
      current.status = 'ready';
      mount();
    } finally {
      syncing = false;
      refreshTag();
    }
  }

  /** The tag by the title whenever the panel isn't showing, and the notice when no session is listening. */
  function refreshTag() {
    const host = document.querySelector(`[${TAG_ATTR}]`);
    const show =
      extensionAlive() &&
      current &&
      prOfLocation() &&
      tags.resultOf(current.pr) &&
      !(current.overlay && panelOnPage());
    if (!show) {
      host?.remove();
      tags.hideNotice();
      return;
    }
    // show is false without a current page
    let tag = host;
    if (tag && tag.getAttribute(TAG_ATTR) !== current!.key) {
      tag.remove();
      tag = null;
    }
    if (!tag) {
      const title = titleElement();
      if (!title) {
        return;
      }
      tag = tags.hostFor(current!.pr);
      title.after(tag);
    }
    tags.show(tag, current!.pr);
    tags.showNotice([current!.pr.repo]);
  }

  /** The panel went away: the tag shows again, as the bridge has it now (the panel may have asked for an update). */
  async function tagAfterPanel() {
    refreshTag();
    const mine = current;
    const answer = await tags.look([mine!.pr], { force: true }); // called while a page is current
    if (answer.ok && current === mine) {
      refreshTag();
    }
  }

  /** The tag's Story: show the panel again, from the story as it is now. */
  async function openPanel() {
    if (!current || !current.data) {
      return;
    }
    await checkForUpdates();
    current.ui = { ...current.ui, hidden: false };
    mount();
    savePanelUi(current.key, current.ui);
    refreshTag();
  }

  /** When chapters.json changes on disk (Claude filled in a chapter), redraw in place. version: the pulse's, if known. */
  async function checkForUpdates(version?: string | null) {
    if (!current || !current.id) {
      return;
    }
    let now = version;
    if (now === undefined) {
      const answer = await bridge.call(ROUTES.storyVersion, { params: { id: current.id } });
      now = answer.ok ? answer.body.version : null;
    }
    if (!current || now == null || now === current.version) {
      return;
    }
    const mine = current;
    const data = await fetchStory(current.id);
    if (current !== mine || !data) {
      return;
    }
    current.data = data;
    current.version = data.version;
    if (current.overlay) {
      current.ui = {
        ...current.overlay.state,
        hidden: false,
        bodyScroll: current.overlay.bodyScroll,
      };
      mount();
    }
  }

  /** Why there's no panel to show, for the toolbar button's toast. */
  function whyNoStory() {
    if (!current) {
      return '';
    }
    if (current.status === 'not-configured') {
      return 'Set the bridge port and token in the extension options first.';
    }
    if (current.status === 'unreachable') {
      return "The bridge isn't running. Start it with: once-upon serve";
    }
    if (current.problem === 'token') {
      return 'The bridge rejected the token. Copy it again from: once-upon setup';
    }
    return 'The bridge has no story for this PR.';
  }

  /** The toolbar button (or Alt+Shift+S): show or hide the panel. */
  async function toggle() {
    const pr = prOfLocation();
    if (!pr) {
      return toast("Once Upon a Diff works on a pull request's Files changed page.");
    }
    if (!current || current.key !== pr.key || !current.data) {
      await sync();
      if (!current || !current.data) {
        return toast(whyNoStory() || 'No story for this PR.');
      }
    }
    if (current.overlay && panelOnPage()) {
      current.ui = { ...current.overlay.state, hidden: true };
      unmount();
      tagAfterPanel();
      savePanelUi(current.key, current.ui);
    } else {
      await openPanel();
    }
  }

  /** Before a reload of our own: save the panel's step and scroll, so it comes back where it was. */
  async function keepPanelPlace(key: string | null = current && current.key) {
    if (current && current.key === key && current.overlay) {
      current.ui = {
        ...current.overlay.state,
        hidden: false,
        bodyScroll: current.overlay.bodyScroll,
      };
      await savePanelUi(current.key, current.ui);
    }
  }

  // ---------- Hide whitespace: GitHub's ?w=1, remembered in the bridge's prefs.json (the local page's setting too)
  const checkWhitespace = createWhitespaceCheck({
    prefs: prefsStore({ call: bridge.call, load: loadPrefsCopy, store: storePrefsCopy }),
    session: tabSession,
    keepPanelPlace,
  });
  const whitespaceCheck = async () => {
    if (extensionAlive()) {
      await checkWhitespace();
    }
  };

  /** Every URL change, tick, navigation event and coming back to the tab, from the router. */
  function route({ navigated, reason }: Route) {
    if (navigated) {
      whitespaceCheck().catch(() => {});
      sync();
    } else if (reason === 'event') {
      sync();
    } else if (reason === 'back') {
      // with a story, the panel's tick looks on focus, and Story or the toolbar button looks before showing it
      if (current && !current.id && current.status !== 'loading') {
        current = null; // no story yet: look again (another tab may have asked for one, or it may be done)
        sync();
      }
    } else if (current && current.data && !current.ui.hidden && !panelOnPage()) {
      sync();
    } else if (
      current &&
      !current.data &&
      current.status !== 'loading' &&
      tags.due([current.pr]).length
    ) {
      current = null; // queued or building (every 10s), or the bridge is down (every 30s)
      sync();
    } else if (current && tags.resultOf(current.pr) && !document.querySelector(`[${TAG_ATTR}]`)) {
      refreshTag(); // GitHub swapped out <body> or redrew the header
    }
  }

  /** The first look at the page: a ?w=1 reload, if any, comes before the panel docks. */
  function start() {
    if (extensionAlive()) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === 'toggle') {
          toggle();
        }
      });
      // a tab opened before the port and token were saved looks again as soon as they are
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings && current && !current.data) {
          current = null;
          sync();
        }
      });
    }
    whitespaceCheck()
      .catch(() => {})
      .finally(sync);
  }

  return { route, start };
}
