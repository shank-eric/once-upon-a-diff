/*
 * A GitHub PR's Files changed page (/changes or /files): asks the bridge
 * (through the service worker) whether there's a story for this PR and, if
 * so, docks the story panel. It re-applies the panel after a reload, after
 * GitHub's in-page navigation, and when the story on disk changes, starting
 * from the step saved for this PR. Whenever the panel isn't showing, the PR's
 * story tag sits by the title, as on the Conversation tab (ui/pr-tags.js):
 * Story opens the panel, Build story or Update asks for one. It also keeps
 * GitHub's Hide whitespace (?w=1) in step with the saved setting.
 *
 * It never clicks GitHub's controls, never submits GitHub's forms and makes no
 * network calls of its own: everything goes through the service worker to the
 * bridge on 127.0.0.1.
 */
import { storyOverlay, rangeStepOf } from '../../shared/overlay.js';
import { filesChangedPr } from '../../shared/util/github-paths.js';
import { callBridge, extensionAlive } from '../bridge.js';
import { loadPanelUi, savePanelUi, loadPrefsCopy, storePrefsCopy, tabSession } from '../storage.js';
import { createPrTags, titleElement } from '../ui/pr-tags.js';
import { requestFor, stepOfHash } from '../ui/story-tag.js';
import { toast } from '../ui/toast.js';
import { createWhitespaceCheck, prefsStore } from './hide-whitespace.js';

const PANEL_ID = 'pr-story-panel';
const TAG_ATTR = 'data-prs-files';

const panelOnPage = () => !!document.getElementById(PANEL_ID);
const prOfLocation = () => filesChangedPr(location.pathname);
/** The bridge's answer body, or an Error with its message. */
async function bodyOf(answerPromise) {
  const answer = await answerPromise;
  if (!answer.ok) {
    throw new Error(answer.error);
  }
  return answer.body;
}

export function createFilesChangedPage() {
  // one PR page at a time: {key, owner, repo, number, pr, id, version, data, ui, overlay, status}
  let current = null;
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

  /** The step to open on, once per page: a "Since you read it" range's chapter, or a #prs-step-N from a PR-list tag. */
  function jumpStep() {
    // GitHub's diff of one "Since you read it" chapter's commits opens on that chapter, once per page
    const range = rangeStepOf(current.data.chapters, location.pathname);
    if (range && current.rangeFor !== location.pathname) {
      current.rangeFor = location.pathname;
      return range;
    }
    // a PR-list "Story · 2 of 5 read" tag links Files changed#prs-step-N: open on the first unread chapter, once
    const hashStep = stepOfHash(location.hash);
    if (hashStep && hashStep <= current.data.chapters.length && current.hashFor !== location.href) {
      current.hashFor = location.href;
      return hashStep;
    }
    return null;
  }

  /** The panel's callbacks, all through the bridge. */
  function panelOptions(key, storyId) {
    const storyPath = `/api/stories/${encodeURIComponent(storyId)}`;
    return {
      host: 'GitHub',
      onState: (panelState) => {
        if (!current || current.key !== key) {
          return;
        }
        current.ui = { ...panelState, hidden: false };
        savePanelUi(key, current.ui);
      },
      onPosition: (position) =>
        callBridge('POST', `${storyPath}/position`, { ...position, url: location.href }),
      // a chapter they read (stayed on, or ticked every file of), with the PR head it was read at
      onRead: async (read) => {
        await bodyOf(callBridge('POST', `${storyPath}/read`, read));
      },
      onClose: () => {
        if (!current || current.key !== key) {
          return;
        }
        current.overlay = null;
        current.ui = { ...current.ui, hidden: true };
        savePanelUi(key, current.ui);
        tagAfterPanel();
        toast('Story hidden. Click the PR Story toolbar button (or Alt+Shift+S) to bring it back.');
      },
      ask: async (question) => {
        const answer = await callBridge('POST', `${storyPath}/questions`, {
          ...question,
          url: location.href,
        });
        if (!answer.ok) {
          throw new Error(
            answer.error === 'unreachable' ? 'the bridge is not running' : answer.error,
          );
        }
        return answer.body;
      },
      // only when the reviewer clicks Reload page
      reloadPage: async () => {
        await keepPanelPlace();
        location.reload();
      },
      drafts: {
        load: () => bodyOf(callBridge('GET', `${storyPath}/drafts`)),
        act: (chapter, index, action) =>
          bodyOf(callBridge('POST', `${storyPath}/drafts`, { chapter, index, action })),
      },
      reads: () => bodyOf(callBridge('GET', `${storyPath}/read`)),
      freshness: () => bodyOf(callBridge('GET', `${storyPath}/freshness`)),
      requestUpdate: (base, { retell = false } = {}) =>
        bodyOf(
          callBridge(
            'POST',
            '/api/builds',
            requestFor({ act: 'update', base }, current.pr, { retell }),
          ),
        ),
      status: async () => {
        const answer = await callBridge('GET', `/api/status?story=${encodeURIComponent(storyId)}`);
        if (answer.ok) {
          return answer.body;
        }
        let code = 'down';
        if (answer.status === 401) {
          code = 'token';
        } else if (answer.status === 404) {
          code = 'old';
        }
        throw Object.assign(new Error(answer.error), { code });
      },
      pulse: () => bodyOf(callBridge('GET', `${storyPath}/pulse`)),
      // the story changed on disk (Claude filled in a chapter): redraw in place
      onPulse: (pulse) => {
        if (current && current.key === key && pulse.version !== current.version) {
          checkForUpdates(pulse.version);
        }
      },
      loadQuestions: async () =>
        (await bodyOf(callBridge('GET', `${storyPath}/questions`))).questions,
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
    current.overlay = storyOverlay(current.data, {
      initial: jump ? { ...current.ui, n: jump, all: false } : current.ui,
      ...panelOptions(current.key, current.id),
    });
  }

  async function fetchStory(id) {
    const answer = await callBridge('GET', `/api/stories/${encodeURIComponent(id)}`);
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
      current.ui = await loadPanelUi(pr.key);
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
    let tag = host;
    if (tag && tag.getAttribute(TAG_ATTR) !== current.key) {
      tag.remove();
      tag = null;
    }
    if (!tag) {
      const title = titleElement();
      if (!title) {
        return;
      }
      tag = tags.hostFor(current.pr);
      title.after(tag);
    }
    tags.show(tag, current.pr);
    tags.showNotice([current.pr.repo]);
  }

  /** The panel went away: the tag shows again, as the bridge has it now (the panel may have asked for an update). */
  async function tagAfterPanel() {
    refreshTag();
    const mine = current;
    const answer = await tags.look([mine.pr], { force: true });
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
  async function checkForUpdates(version) {
    if (!current || !current.id) {
      return;
    }
    let now = version;
    if (now === undefined) {
      const answer = await callBridge(
        'GET',
        `/api/stories/${encodeURIComponent(current.id)}/version`,
      );
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
      return "The bridge isn't running. Start it with: pr-story serve";
    }
    if (/HTTP 401|token/.test(current.status)) {
      return 'The bridge rejected the token. Copy it again from: pr-story setup';
    }
    return 'The bridge has no story for this PR.';
  }

  /** The toolbar button (or Alt+Shift+S): show or hide the panel. */
  async function toggle() {
    const pr = prOfLocation();
    if (!pr) {
      return toast("PR Story works on a pull request's Files changed page.");
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
  async function keepPanelPlace(key = current && current.key) {
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
    prefs: prefsStore({ call: callBridge, load: loadPrefsCopy, store: storePrefsCopy }),
    session: tabSession,
    keepPanelPlace,
  });
  const whitespaceCheck = async () => {
    if (extensionAlive()) {
      await checkWhitespace();
    }
  };

  /** Every URL change, tick, navigation event and coming back to the tab, from the router. */
  function route({ navigated, reason }) {
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
