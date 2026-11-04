/*
 * The panel's frame: the host element and its shadow root, the toolbar
 * (status light, Hide story, Prev, Next, close), the note line, the body and
 * the questions dock (chat-dock.ts), plus the message line, docking width and collapse.
 */
import { Fragment, html, render } from '/assets/preact.mjs';
import { hideUntilStyled, stopKeyEvents, stylesheetLink } from './dom.ts';
import { createView } from './store.ts';
import type { PanelContext } from './context.ts';

/**
 * The questions dock's frame. The dock's own parts (chat-dock.ts, ask/questions.ts, status-light.ts) bind to these elements and
 * write into them, so it is the same elements, with the same props, on every draw: Preact leaves them as they are.
 */
const askDock = (
  withAsk: boolean,
) => html`<section class="ou-chat" aria-label="Questions for Claude">
      <div class="ou-chatgrip" title="Drag to resize"></div>
      <button type="button" class="ou-chathead" aria-expanded="false" title="Open or close the questions">
        <span class="ou-chatarrow" aria-hidden="true">▸</span><span class="ou-chatlabel">Ask Claude</span><span class="ou-chatcount"></span>
      </button>
      <div class="ou-chatbody"><div class="ou-questions"></div></div>
      <div class="ou-chatfoot">
        <div class="ou-askhint" hidden=${true}></div>
        <div class="ou-askwho" hidden=${true}></div>
        <form class=${withAsk ? 'ou-ask' : 'ou-ask ou-off'}>
          <textarea placeholder="Ask about this step. The list above holds the whole story (Cmd+Enter sends it to the bridge inbox)" rows="1" aria-label="Question"></textarea>
          <button type="submit">Ask</button>
        </form>
      </div>
    </section>`;

const MESSAGE_MS = 8000;
const MIN_WIDTH = 280;
const MAX_WIDTH_SHARE = 0.7;
const COLLAPSED_WIDTH = 36;

export function createShell(context: PanelContext) {
  const { hostId, panelId, opts, state } = context;
  // page.css goes in the page's head, panel.css in the shadow root, from where the host says (opts.stylesheets): the
  // extension's copy on GitHub, the bridge's /assets/panel/ on the local page.
  const pageStyle = stylesheetLink(opts.stylesheets.page);
  pageStyle.id = hostId + '-style';
  const panelStyle = stylesheetLink(opts.stylesheets.panel);
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(panelStyle);
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

  /** The toolbar, the note under it, the body, and the questions dock: all of the panel, drawn from the parts' data. */
  function frame() {
    const chapter = context.chapter();
    const title = chapter ? chapter.title : `Overview: ${context.story.data.pr.title || ''}`;
    const lastStep = context.steps().length;
    const withBody = !!context.body?.ready();
    return html`<${Fragment}>
      <div class="ou-grip" title="Drag to resize"></div>
      <div class="ou-bar">
        <button class="ou-light" title="Checking the connection…" aria-label="Connection status" aria-expanded="false"><span class="ou-dot"></span></button>
        <button class="ou-toggle" title="Collapse or expand the story panel" onClick=${toggleCollapsed}>${state.collapsed ? 'Show story' : 'Hide story'}</button>
        <button class="ou-prev" title="Previous step" disabled=${withBody && state.n === 0} onClick=${() => context.navigation.go(state.n - 1)}>← Prev</button>
        <span class="ou-title" title=${withBody ? title : undefined}>${withBody ? title : null}</span>
        <button class="ou-next" title="Next step" disabled=${withBody && state.n === lastStep} onClick=${() => context.navigation.go(state.n + 1)}>Next →</button>
        <button class="ou-close" title="Remove the overlay and show every file" onClick=${close}>×</button>
      </div>
      <div class="ou-note"><span class="ou-count-note">${context.filter ? context.filter.noteView() : null}</span><div class="ou-health" hidden=${true}></div><div class="ou-fresh"></div><div class="ou-rebuilding" role="status" hidden=${true}></div><span class="ou-msg">${messageText || null}</span></div>
      <div class="ou-body">${context.body ? context.body.view() : null}</div>
      ${askDock(!!opts.ask)}
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
    setCollapsed(!state.collapsed);
    context.saveState();
  }
  function close() {
    context.destroy();
    if (opts.onClose) {
      opts.onClose();
    }
  }

  // resize by dragging the left edge
  $('.ou-grip')!.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    root.classList.add('ou-dragging');
    const onPointerMove = (moveEvent: PointerEvent) =>
      setWidth(window.innerWidth - moveEvent.clientX);
    const onPointerUp = () => {
      context.saveState();
      opts.onLayout?.({ width: state.width });
      root.classList.remove('ou-dragging');
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', onPointerUp);
    };
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerUp);
  });
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
    hideUntilStyled(host, [pageStyle, panelStyle]);
    document.head.appendChild(pageStyle);
    shadow.appendChild(root);
    document.body.appendChild(host);
    document.documentElement.classList.add(hostId + '-docked');
  }

  /** Take the panel off the page and undock it. */
  function unmount() {
    mounted = false; // what is on the panel stays as it was, for a late answer to write into
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
    redraw,
    clearMessageTimer: () => clearTimeout(messageTimer),
    stopResizing: () => window.removeEventListener('resize', onResize),
  };
}

export type Shell = ReturnType<typeof createShell>;
