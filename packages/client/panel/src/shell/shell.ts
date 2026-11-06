/*
 * The panel's frame: the host element and its shadow root, the toolbar
 * (status light, Hide story, Prev, Next, close), the note line, the body and
 * the questions dock, plus the message line, docking width and collapse. The parts draw what is theirs (the light, the checks,
 * the dock) through their views; the frame draws the rest.
 */
import { Fragment, html, render } from '/assets/preact.mjs';
import { hideUntilStyled, stopKeyEvents, stylesheetLink } from '@once-upon-a-diff/ui-kit/dom';
import { createDrag } from '@once-upon-a-diff/ui-kit/drag';
import { createView } from '../state/store.ts';
import type { PanelContext } from '../host/context.ts';

const MESSAGE_MS = 8000;
const MIN_WIDTH = 280;
const MAX_WIDTH_SHARE = 0.7;
const COLLAPSED_WIDTH = 36;

export function createShell(context: PanelContext) {
  const { hostId, panelId, opts, state } = context;
  // tokens.css (the --ou-* theme tokens) and page.css go in the page's head, tokens.css (a second link, a link sits in one place),
  // ui.css (the shared pieces), panel.css and then each region's sheet in the shadow root, in that order, from where the host says
  // (opts.stylesheets): the extension's copies on GitHub, the bridge's /assets/ on the local page.
  const pageTokens = stylesheetLink(opts.stylesheets.tokens);
  pageTokens.id = hostId + '-tokens';
  const pageStyle = stylesheetLink(opts.stylesheets.page);
  pageStyle.id = hostId + '-style';
  const shadowTokens = stylesheetLink(opts.stylesheets.tokens);
  const uiStyle = stylesheetLink(opts.stylesheets.ui);
  const panelStyle = stylesheetLink(opts.stylesheets.panel);
  const regionStyles = opts.stylesheets.regions.map(stylesheetLink);
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(shadowTokens, uiStyle, panelStyle, ...regionStyles);
  const root = document.createElement('aside');
  root.id = panelId;
  // focusable, so a click anywhere in the panel moves focus off the page and the page's single-key shortcuts (GitHub's, Refined GitHub's j/k/x) don't fire while you read
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Once Upon a Diff');
  /** The panel's element for selector, or null. The frame's own (.ou-title, .ou-body...) are always there. */
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
    root.querySelector<T>(selector);

  let messageText = '';
  let messageTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let mounted = true;

  // resize by dragging the left edge
  const drag = createDrag({
    onStart: () => root.classList.add('ou-dragging'),
    onMove: (event) => setWidth(window.innerWidth - event.clientX),
    onEnd: () => {
      context.saveState();
      opts.onLayout?.({ width: state.width });
      root.classList.remove('ou-dragging');
    },
  });

  /** The toolbar, the note under it, the body, and the questions dock: all of the panel, drawn from the parts' data. */
  function frame() {
    const chapter = context.chapter();
    const title = chapter ? chapter.title : `Overview: ${context.story.data.pr.title || ''}`;
    const lastStep = context.steps().length;
    const withBody = !!context.body?.ready();
    return html`<${Fragment}>
      <div class="ou-grip" title="Drag to resize" ...${drag.handlers}></div>
      <div class="ou-bar">
        ${context.statusLight ? context.statusLight.lightView() : null}
        <button class="ou-toggle" title="Collapse or expand the story panel" onClick=${toggleCollapsed}>${state.collapsed ? 'Show story' : 'Hide story'}</button>
        <button class="ou-prev" title="Previous step" disabled=${withBody && state.n === 0} onClick=${() => {
          context.count('panel.step.prev');
          context.navigation.go(state.n - 1);
        }}>← Prev</button>
        <span class="ou-title" title=${withBody ? title : undefined}>${withBody ? title : null}</span>
        <button class="ou-next" title="Next step" disabled=${withBody && state.n === lastStep} onClick=${() => {
          context.count('panel.step.next');
          context.navigation.go(state.n + 1);
        }}>Next →</button>
        <button class="ou-close" title="Remove the overlay and show every file" onClick=${close}>×</button>
      </div>
      <div class="ou-note"><span class="ou-count-note">${context.filter ? context.filter.noteView() : null}</span>${context.statusLight ? context.statusLight.healthView() : null}${context.freshness ? context.freshness.view() : null}${context.rebuild ? context.rebuild.statusView() : null}<span class="ou-msg">${messageText || null}</span></div>
      <div class="ou-body">${context.body ? context.body.view() : null}</div>
      ${context.chatDock ? context.chatDock.view() : null}
    </${Fragment}>`;
  }
  // the frame is drawn here, before any part is built: they take hold of its elements (the dock, the note, the light) when they are
  const view = createView(() => render(frame(), root));
  view.update();

  /** Draws the panel again from the parts' data (a part's data changed). Done by the time it returns. */
  function redraw() {
    if (mounted) {
      view.update();
    }
  }

  /** A line under the toolbar for a few seconds ('' clears it). */
  function message(text: string | null | undefined) {
    if (!mounted) {
      return; // a late answer after the panel was closed
    }
    clearTimeout(messageTimer);
    messageText = text || '';
    redraw();
    if (text) {
      messageTimer = setTimeout(() => {
        messageText = '';
        redraw();
      }, MESSAGE_MS);
    }
  }

  function setWidth(width: number) {
    state.width = Math.round(
      Math.min(Math.max(width, MIN_WIDTH), window.innerWidth * MAX_WIDTH_SHARE),
    );
    document.documentElement.style.setProperty(
      '--ou-w',
      (state.collapsed ? COLLAPSED_WIDTH : state.width) + 'px',
    );
  }
  function setCollapsed(collapsed: boolean) {
    state.collapsed = collapsed;
    root.classList.toggle('ou-collapsed', collapsed);
    redraw(); // the toggle's label
    setWidth(state.width);
  }
  function toggleCollapsed() {
    context.count('panel.collapse');
    setCollapsed(!state.collapsed);
    context.saveState();
  }
  function close() {
    context.count('panel.close');
    context.destroy();
    if (opts.onClose) {
      opts.onClose();
    }
  }

  const onResize = () => setWidth(state.width);
  window.addEventListener('resize', onResize);

  // a jump link is a <code role="link" tabindex="0">: Enter or Space on it does what a click does
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const link =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-rel]') : null;
    if (link && link === event.target) {
      event.preventDefault();
      link.click();
    }
  });

  /** Keep the host page's keyboard shortcuts out of the panel while typing. */
  const isolateKeys = () => stopKeyEvents(root);

  /** Put the panel on the page and dock it. */
  function mount() {
    hideUntilStyled(host, [shadowTokens, pageStyle, uiStyle, panelStyle, ...regionStyles]);
    document.head.append(pageTokens, pageStyle);
    shadow.appendChild(root);
    document.body.appendChild(host);
    document.documentElement.classList.add(hostId + '-docked');
  }

  /** Take the panel off the page and undock it. */
  function unmount() {
    mounted = false; // what is on the panel stays as it was, for a late answer to write into
    host.remove();
    pageTokens.remove();
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
    redraw,
    clearMessageTimer: () => clearTimeout(messageTimer),
    stopResizing: () => window.removeEventListener('resize', onResize),
  };
}

export type Shell = ReturnType<typeof createShell>;
