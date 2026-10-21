/*
 * A GitHub PR's Files changed page (/changes or /files): asks the bridge
 * (through the service worker) whether there's a story for this PR and, if
 * so, docks the story panel. It re-applies the panel after a reload, after
 * GitHub's in-page navigation, and when the story on disk changes, starting
 * from the step saved for this PR. Without a story it shows the status
 * control (Build story, Queued, Building…). It also keeps GitHub's Hide
 * whitespace (?w=1) in step with the saved setting.
 *
 * It never clicks GitHub's controls, never submits GitHub's forms and makes no
 * network calls of its own: everything goes through the service worker to the
 * bridge on 127.0.0.1.
 */
import { storyOverlay, rangeStepOf } from '../../shared/overlay.js';
import { filesChangedPr } from '../../shared/util/github-paths.js';
import { callBridge, extensionAlive } from '../bridge.js';
import { loadPanelUi, savePanelUi, loadPrefsCopy, storePrefsCopy, tabSession } from '../storage.js';
import { statusControl } from '../ui/status-control.js';
import { stepOfHash } from '../ui/story-tag.js';
import { toast } from '../ui/toast.js';
import { createWhitespaceCheck, prefsStore } from './hide-whitespace.js';

const PANEL_ID = 'diff-story-panel';
const STATUS_ID = 'diff-story-status';
const UPDATE_POLL_MS = 5000;
const BUILD_POLL_MS = 10000;
const OFFLINE_POLL_MS = 30000;

const panelOnPage = () => !!document.getElementById(PANEL_ID);
const prOfLocation = () => filesChangedPr(location.pathname);
const prUrl = (pr) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
/** The bridge's answer body, or an Error with its message. */
async function bodyOf(answerPromise) {
  const answer = await answerPromise;
  if (!answer.ok) {
    throw new Error(answer.error);
  }
  return answer.body;
}

export function createFilesChangedPage() {
  // one PR page at a time: {key, owner, repo, number, id, version, data, ui, overlay, status, build, listening}
  let current = null;
  let syncing = false;
  let lastRetry = 0;

  function unmount() {
    if (current && current.overlay) {
      current.overlay.destroy();
    }
    if (current) {
      current.overlay = null;
    }
  }

  /** The step to open on, once per page: a "Since you read it" range's chapter, or a #dsm-step-N from a PR-list tag. */
  function jumpStep() {
    // GitHub's diff of one "Since you read it" chapter's commits opens on that chapter, once per page
    const range = rangeStepOf(current.data.chapters, location.pathname);
    if (range && current.rangeFor !== location.pathname) {
      current.rangeFor = location.pathname;
      return range;
    }
    // a PR-list "Story · 2 of 5 read" tag links Files changed#dsm-step-N: open on the first unread chapter, once
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
        refreshStatus();
        toast(
          'Story hidden. Click the Diff Story Mode toolbar button (or Alt+Shift+S) to bring it back.',
        );
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
      requestUpdate: (base, { retell = false } = {}) => {
        const pr = prOfLocation();
        return bodyOf(
          callBridge('POST', '/api/builds', {
            repo: `${pr.owner}/${pr.repo}`,
            number: pr.number,
            url: prUrl(pr),
            requested_at: new Date().toISOString(),
            mode: 'update',
            base_sha: base,
            ...(retell ? { retell: true } : {}),
          }),
        );
      },
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
      initial: jump ? { ...current.ui, n: jump, all: false, view: 'story' } : current.ui,
      ...panelOptions(current.key, current.id),
    });
  }

  async function fetchStory(id) {
    const answer = await callBridge('GET', `/api/stories/${encodeURIComponent(id)}`);
    return answer.ok ? answer.body : null;
  }

  /** No story for this PR: is one being built, and is a session listening for the repo to build it? */
  async function lookForBuild(mine, query) {
    const build = await callBridge('GET', `/api/builds/status?${query}`);
    if (current !== mine) {
      return;
    }
    current.build = build.ok ? build.body.request : null;
    // is a session listening for this repo to build it? (the status light's check, per repo)
    const listen = await callBridge('GET', `/api/status?${query}`);
    if (current !== mine) {
      return;
    }
    current.listening = listen.ok ? listen.body.listening : null;
    // queued: asked for, no session has it yet. building: a session claimed it.
    const inFlight = build.ok && (build.body.state === 'queued' || build.body.state === 'building');
    current.status = inFlight ? build.body.state : 'none';
    if (build.ok && build.body.state === 'ready') {
      current = null; // it turned up in between; the next tick picks it up
    }
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
        id: null,
        version: null,
        data: null,
        ui: {},
        overlay: null,
        status: 'loading',
      };
      const mine = current;
      const query = `repo=${encodeURIComponent(`${pr.owner}/${pr.repo}`)}&number=${pr.number}`;
      const found = await callBridge('GET', `/api/stories/find?${query}`);
      if (current !== mine) {
        return;
      }
      if (!found.ok && found.status === 404) {
        await lookForBuild(mine, query);
        return;
      }
      if (!found.ok) {
        current.status = found.error || `HTTP ${found.status}`;
        return;
      }
      const data = await fetchStory(found.body.id);
      if (current !== mine || !data) {
        return;
      }
      current.id = found.body.id;
      current.version = data.version;
      current.data = data;
      current.ui = await loadPanelUi(pr.key);
      current.status = 'ready';
      mount();
    } finally {
      syncing = false;
      refreshStatus();
    }
  }

  // ---------- the status control: story ready / building / build story
  const status = statusControl({
    onOpen: () => {
      if (!current || !current.data) {
        return;
      }
      current.ui = { ...current.ui, hidden: false };
      mount();
      savePanelUi(current.key, current.ui);
      refreshStatus();
    },
    onBuild: () => requestBuild(),
  });

  function refreshStatus() {
    if (!extensionAlive() || !current || !prOfLocation()) {
      return status.set('hidden');
    }
    if (current.data) {
      return status.set(current.overlay && panelOnPage() ? 'hidden' : 'ready');
    }
    const listener = current.listening && !current.listening.ok ? current.listening : null;
    const prompt = listener ? listener.prompt : null;
    const more = listener
      ? { details: listener.details, repo: listener.repo, checkout: listener.checkout }
      : {};
    if (current.status === 'queued' || current.status === 'building') {
      return status.set(current.status, {
        requested_at: current.build && current.build.requested_at,
        prompt,
        ...more,
      });
    }
    if (current.status === 'none') {
      const failed = current.build && current.build.status === 'failed' ? 'Last build failed.' : '';
      return status.set('none', { note: failed, prompt, ...more });
    }
    if (current.status === 'unreachable') {
      return status.set('offline', { note: 'Story bridge offline' });
    }
    if (/HTTP 401|token/.test(current.status || '')) {
      return status.set('offline', { note: 'Story bridge rejected the token' });
    }
    return status.set('hidden'); // loading, or not set up yet
  }

  async function requestBuild() {
    const pr = prOfLocation();
    if (!pr || !current || current.key !== pr.key) {
      return;
    }
    const mine = current;
    const answer = await callBridge('POST', '/api/builds', {
      repo: `${pr.owner}/${pr.repo}`,
      number: pr.number,
      url: prUrl(pr),
      requested_at: new Date().toISOString(),
    });
    if (current !== mine) {
      return;
    }
    if (answer.ok) {
      current.status = answer.body.state === 'building' ? 'building' : 'queued';
      current.build = answer.body.request;
      lastRetry = Date.now();
    } else {
      toast(
        answer.status === 404
          ? 'This bridge is older than the Build story button. Restart it: diff-story serve'
          : `Couldn't ask the bridge: ${answer.error}`,
      );
    }
    refreshStatus();
  }

  /** When chapters.json changes on disk (Claude filled in a chapter), redraw in place. */
  async function checkForUpdates() {
    if (!current || document.visibilityState !== 'visible') {
      return;
    }
    if (!current.id) {
      // poll only while a build is pending (every 10s), or slowly while the bridge is down (every 30s)
      let every = 0;
      if (current.status === 'queued' || current.status === 'building') {
        every = BUILD_POLL_MS;
      } else if (current.status === 'unreachable') {
        every = OFFLINE_POLL_MS;
      }
      if (every && Date.now() - lastRetry > every) {
        lastRetry = Date.now();
        current = null;
        sync();
      }
      return;
    }
    const answer = await callBridge(
      'GET',
      `/api/stories/${encodeURIComponent(current.id)}/version`,
    );
    if (!answer.ok || !current || answer.body.version === current.version) {
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
      return "The bridge isn't running. Start it with: diff-story serve";
    }
    if (/HTTP 401|token/.test(current.status)) {
      return 'The bridge rejected the token. Copy it again from: diff-story setup';
    }
    return 'The bridge has no story for this PR.';
  }

  /** The toolbar button (or Alt+Shift+S): show or hide the panel. */
  async function toggle() {
    const pr = prOfLocation();
    if (!pr) {
      return toast("Diff Story Mode works on a pull request's Files changed page.");
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
    } else {
      current.ui = { ...current.ui, hidden: false };
      mount();
    }
    savePanelUi(current.key, current.ui);
    refreshStatus();
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

  /** Every URL change, tick and navigation event, from the router. */
  function route({ navigated, reason }) {
    if (navigated) {
      whitespaceCheck().catch(() => {});
      sync();
    } else if (reason === 'event') {
      sync();
    } else if (current && current.data && !current.ui.hidden && !panelOnPage()) {
      sync();
    } else if (current && !document.getElementById(STATUS_ID)) {
      refreshStatus(); // GitHub swapped out <body>
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
    // a comment drafted in the terminal shows up as soon as you come back to the tab
    window.addEventListener('focus', () => {
      if (extensionAlive() && current && current.id) {
        checkForUpdates();
      }
    });
    // coming back to a tab with no story: look once (another tab may have asked for a build, or the story may be done)
    document.addEventListener('visibilitychange', () => {
      const back = extensionAlive() && document.visibilityState === 'visible' && current;
      if (back && current.id) {
        checkForUpdates();
      }
      if (back && !current.data && current.status !== 'loading') {
        current = null;
        sync();
      }
    });
    setInterval(() => {
      if (extensionAlive()) {
        checkForUpdates();
      }
    }, UPDATE_POLL_MS);
    whitespaceCheck()
      .catch(() => {})
      .finally(sync);
  }

  return { route, start };
}
