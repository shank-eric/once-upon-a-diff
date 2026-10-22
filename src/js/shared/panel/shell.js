/*
 * The panel's frame: the host element and its shadow root, the toolbar
 * (status light, Hide story, Prev, Next, close), the note line, the body and
 * the Ask box, plus the message line, docking width and collapse.
 */
import { stopKeyEvents } from '../util/dom.js';
import { documentCss, panelCss } from './styles.js';

const MARKUP = (withAsk) => `
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
    <form class="prs-ask${withAsk ? '' : ' prs-off'}">
      <textarea placeholder="Ask about this step (Cmd+Enter sends it to the bridge inbox)" rows="1" aria-label="Question"></textarea>
      <button type="submit">Ask</button>
    </form>`;

const MESSAGE_MS = 8000;
const MIN_WIDTH = 280;
const MAX_WIDTH_SHARE = 0.7;
const COLLAPSED_WIDTH = 36;

export function createShell(context) {
  const { hostId, panelId, opts, state } = context;
  const pageStyle = document.createElement('style');
  pageStyle.id = hostId + '-style';
  pageStyle.textContent = documentCss(hostId);
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  const panelStyle = document.createElement('style');
  panelStyle.textContent = panelCss(panelId);
  shadow.appendChild(panelStyle);
  const root = document.createElement('aside');
  root.id = panelId;
  // focusable, so a click anywhere in the panel moves focus off the page and the page's single-key shortcuts (GitHub's, Refined GitHub's j/k/x) don't fire while you read
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Diff story');
  root.innerHTML = MARKUP(!!opts.ask);
  const $ = (selector) => root.querySelector(selector);

  let messageTimer = 0;
  /** A line under the toolbar for a few seconds ('' clears it). */
  function message(text) {
    clearTimeout(messageTimer);
    $('.prs-msg').textContent = text || '';
    if (text) {
      messageTimer = setTimeout(() => {
        $('.prs-msg').textContent = '';
      }, MESSAGE_MS);
    }
  }

  function setWidth(width) {
    state.width = Math.round(
      Math.min(Math.max(width, MIN_WIDTH), window.innerWidth * MAX_WIDTH_SHARE),
    );
    document.documentElement.style.setProperty(
      '--dsm-w',
      (state.collapsed ? COLLAPSED_WIDTH : state.width) + 'px',
    );
  }
  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    root.classList.toggle('prs-collapsed', collapsed);
    $('.prs-toggle').textContent = collapsed ? 'Show story' : 'Hide story';
    setWidth(state.width);
  }

  // resize by dragging the left edge
  $('.prs-grip').addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    root.classList.add('prs-dragging');
    const onPointerMove = (moveEvent) => setWidth(window.innerWidth - moveEvent.clientX);
    const onPointerUp = () => {
      context.saveState();
      root.classList.remove('prs-dragging');
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', onPointerUp);
    };
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerUp);
  });
  $('.prs-toggle').onclick = () => {
    setCollapsed(!state.collapsed);
    context.saveState();
  };
  $('.prs-prev').onclick = () => context.navigation.go(state.n - 1);
  $('.prs-next').onclick = () => context.navigation.go(state.n + 1);
  $('.prs-close').onclick = () => {
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
    const link = event.target instanceof Element ? event.target.closest('[data-rel]') : null;
    if (link && link === event.target) {
      event.preventDefault();
      link.click();
    }
  });

  /** Keep the host page's keyboard shortcuts out of the panel while typing. */
  const isolateKeys = () => stopKeyEvents(root);

  /** Put the panel on the page and dock it. */
  function mount() {
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
    document.documentElement.style.removeProperty('--dsm-w');
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
