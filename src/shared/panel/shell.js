/*
 * The panel's frame: the host element and its shadow root, the toolbar
 * (status light, Hide story, Prev, Next, close), the note line, the body and
 * the Ask box, plus the message line, docking width and collapse.
 */
import { hideUntilStyled, stopKeyEvents, stylesheetLink } from '../util/dom.js';

const MARKUP = (withAsk) => `
    <div class="ou-grip" title="Drag to resize"></div>
    <div class="ou-bar">
      <button class="ou-light" title="Checking the connection…" aria-label="Connection status" aria-expanded="false"><span class="ou-dot"></span></button>
      <button class="ou-toggle" title="Collapse or expand the story panel">Hide story</button>
      <button class="ou-prev" title="Previous step">&larr; Prev</button>
      <span class="ou-title"></span>
      <button class="ou-next" title="Next step">Next &rarr;</button>
      <button class="ou-close" title="Remove the overlay and show every file">&times;</button>
    </div>
    <div class="ou-note"><span class="ou-count-note"></span><div class="ou-health" hidden></div><div class="ou-fresh"></div><div class="ou-rebuilding" role="status" hidden></div><span class="ou-msg"></span></div>
    <div class="ou-body"></div>
    <div class="ou-askhint" hidden></div>
    <div class="ou-askwho" hidden></div>
    <form class="ou-ask${withAsk ? '' : ' ou-off'}">
      <textarea placeholder="Ask about this step (Cmd+Enter sends it to the bridge inbox)" rows="1" aria-label="Question"></textarea>
      <button type="submit">Ask</button>
    </form>`;

const MESSAGE_MS = 8000;
const MIN_WIDTH = 280;
const MAX_WIDTH_SHARE = 0.7;
const COLLAPSED_WIDTH = 36;

export function createShell(context) {
  const { hostId, panelId, opts, state } = context;
  // page.css goes in the page's head, panel.css in the shadow root. Both are next to this module: the extension's
  // copy on GitHub, the bridge's /assets/panel/ on the local page.
  const pageStyle = stylesheetLink(new URL('./page.css', import.meta.url).href);
  pageStyle.id = hostId + '-style';
  const panelStyle = stylesheetLink(new URL('./panel.css', import.meta.url).href);
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(panelStyle);
  const root = document.createElement('aside');
  root.id = panelId;
  // focusable, so a click anywhere in the panel moves focus off the page and the page's single-key shortcuts (GitHub's, Refined GitHub's j/k/x) don't fire while you read
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Once Upon a Diff');
  root.innerHTML = MARKUP(!!opts.ask);
  const $ = (selector) => root.querySelector(selector);

  let messageTimer = 0;
  /** A line under the toolbar for a few seconds ('' clears it). */
  function message(text) {
    clearTimeout(messageTimer);
    $('.ou-msg').textContent = text || '';
    if (text) {
      messageTimer = setTimeout(() => {
        $('.ou-msg').textContent = '';
      }, MESSAGE_MS);
    }
  }

  function setWidth(width) {
    state.width = Math.round(
      Math.min(Math.max(width, MIN_WIDTH), window.innerWidth * MAX_WIDTH_SHARE),
    );
    document.documentElement.style.setProperty(
      '--ou-w',
      (state.collapsed ? COLLAPSED_WIDTH : state.width) + 'px',
    );
  }
  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    root.classList.toggle('ou-collapsed', collapsed);
    $('.ou-toggle').textContent = collapsed ? 'Show story' : 'Hide story';
    setWidth(state.width);
  }

  // resize by dragging the left edge
  $('.ou-grip').addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    root.classList.add('ou-dragging');
    const onPointerMove = (moveEvent) => setWidth(window.innerWidth - moveEvent.clientX);
    const onPointerUp = () => {
      context.saveState();
      root.classList.remove('ou-dragging');
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', onPointerUp);
    };
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerUp);
  });
  $('.ou-toggle').onclick = () => {
    setCollapsed(!state.collapsed);
    context.saveState();
  };
  $('.ou-prev').onclick = () => context.navigation.go(state.n - 1);
  $('.ou-next').onclick = () => context.navigation.go(state.n + 1);
  $('.ou-close').onclick = () => {
    context.destroy();
    if (opts.onClose) {
      opts.onClose();
    }
  };
  const onResize = () => setWidth(state.width);
  window.addEventListener('resize', onResize);

  // a jump link is a <code role="link" tabindex="0">: Enter or Space on it does what a click does
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const link =
      event.target instanceof Element
        ? /** @type {HTMLElement | null} */ (event.target.closest('[data-rel]'))
        : null;
    if (link && link === event.target) {
      event.preventDefault();
      link.click();
    }
  });

  /** Keep the host page's keyboard shortcuts out of the panel while typing. */
  const isolateKeys = () => stopKeyEvents(root);

  /** Put the panel on the page and dock it. */
  function mount() {
    hideUntilStyled(host, [pageStyle, panelStyle]);
    document.head.appendChild(pageStyle);
    shadow.appendChild(root);
    document.body.appendChild(host);
    document.documentElement.classList.add(hostId + '-docked');
  }

  /** Take the panel off the page and undock it. */
  function unmount() {
    host.remove();
    pageStyle.remove();
    document.documentElement.classList.remove(hostId + '-docked');
    document.documentElement.style.removeProperty('--ou-w');
  }

  return {
    host,
    root,
    $,
    message,
    setWidth,
    setCollapsed,
    isolateKeys,
    mount,
    unmount,
    clearMessageTimer: () => clearTimeout(messageTimer),
    stopResizing: () => window.removeEventListener('resize', onResize),
  };
}
