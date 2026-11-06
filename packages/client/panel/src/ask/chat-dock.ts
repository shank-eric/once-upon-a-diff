/*
 * The questions dock at the bottom of the panel: a header that opens and
 * closes it, and when open, the questions and answers (scrolling on their
 * own) over the Ask box. Its top edge drags to set its height. Open and
 * height are saved with the panel's state (chatOpen, chatHeight).
 *
 * The header says how many questions the story has, how many a session is
 * working on or waits for one, and how many answers nobody has read. The
 * bridge keeps what was read, so the count holds across reloads and pages.
 *
 * The dock draws itself (view) and the questions, the hint and who lines, and the Ask box inside it draw theirs. The one thing done
 * by hand is the height: a drag writes --ou-chat-h on the dock as the pointer moves, instead of drawing the panel for each move.
 */
import { html } from '/assets/preact.mjs';
import { plural } from '@once-upon-a-diff/terms/text';
import { Disclosure } from '@once-upon-a-diff/ui-kit/components/disclosure';
import { createDrag } from '@once-upon-a-diff/ui-kit/drag';
import type { PanelContext } from '../host/context.ts';
import { dockHeightWithin } from '../shell/layout.ts';

/** How close to the bottom (px) still counts as reading the latest, so a new answer scrolls into view. */
const PINNED_SLACK = 24;

export interface ChatCounts {
  open: number;
  /** no answer, and no session on it yet */
  waiting: number;
  /** a session is working on it */
  working: number;
  /** answers not read yet */
  unread: number;
}

export function createChatDock(context: PanelContext) {
  const { state, opts, shell } = context;
  const { $, root } = shell;
  let counts: ChatCounts = { open: 0, waiting: 0, working: 0, unread: 0 };
  const scroller = () => $('.ou-chatbody');

  function countLine(): string {
    const parts = [
      counts.open > 0 && plural(counts.open, 'question'),
      counts.working > 0 && `${counts.working} being worked on`,
      counts.waiting > 0 && `${counts.waiting} waiting`,
      counts.unread > 0 && plural(counts.unread, 'unread answer'),
    ].filter(Boolean);
    return parts.join(' · ');
  }

  /**
   * Shows the dock at height, kept within the panel, and returns what it showed. The saved height (state.chatHeight)
   * is the reader's: only a drag changes it, so a small window or a panel not laid out yet can't shrink it for good.
   * A panel whose stylesheet hasn't loaded yet has no real height to be kept within, so the panel's resizes
   * (the stylesheet arriving, the window changing) show it again.
   */
  function showHeight(height: number) {
    const shown = dockHeightWithin(height, root.clientHeight);
    $('.ou-chat')?.style.setProperty('--ou-chat-h', shown + 'px');
    return shown;
  }

  function setOpen(open: boolean) {
    state.chatOpen = open;
    shell.redraw(); // the dock's class, arrow and header
    if (open) {
      showHeight(state.chatHeight);
      scrollToLatest();
    }
  }

  function scrollToLatest() {
    const box = scroller();
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }

  /** Is the conversation scrolled to (about) its end? */
  function isPinned() {
    const box = scroller();
    return !box || box.scrollHeight - box.scrollTop - box.clientHeight <= PINNED_SLACK;
  }

  /** Redraws the conversation through draw, keeping you at the end if you were there. */
  function redraw(draw: () => void) {
    const pinned = isPinned();
    draw();
    if (pinned) {
      scrollToLatest();
    }
  }

  /** The header's counts: drawn with the next draw (the questions part draws right after). */
  function setCounts(next: ChatCounts) {
    counts = next;
  }

  function toggle() {
    context.count('panel.dock.toggle');
    setOpen(!state.chatOpen);
    context.saveState();
    if (state.chatOpen) {
      $<HTMLTextAreaElement>('.ou-ask textarea')?.focus();
    }
  }

  // resize by dragging the top edge: a closed dock does not drag
  let bottom = 0;
  const drag = createDrag({
    onStart: () => {
      const dock = $('.ou-chat');
      if (!state.chatOpen || !dock) {
        return false;
      }
      dock.classList.add('ou-chat-dragging');
      bottom = dock.getBoundingClientRect().bottom;
    },
    onMove: (event) => {
      state.chatHeight = showHeight(bottom - event.clientY);
    },
    onEnd: () => {
      context.saveState();
      opts.onLayout?.({ chatHeight: state.chatHeight });
      $('.ou-chat')?.classList.remove('ou-chat-dragging');
    },
  });
  const onResize = () => {
    if (state.chatOpen) {
      showHeight(state.chatHeight);
    }
  };
  window.addEventListener('resize', onResize);
  // the panel is mounted before its stylesheet arrives, so the open dock is first shown within an unstyled panel's
  // height: show it at the saved height again once the panel has its real size
  const sizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  sizeWatch?.observe(root);

  /** The dock: the header and its counts, the questions, and under them the hint, the who line and the Ask box. */
  function view() {
    const open = state.chatOpen;
    const line = countLine();
    return html`<section class=${open ? 'ou-chat ou-open' : 'ou-chat'} aria-label="Questions for Claude" hidden=${!opts.ask && !opts.loadQuestions}>
      <div class="ou-chatgrip" title="Drag to resize" ...${drag.handlers}></div>
      <${Disclosure} open=${open} class="ou-chathead" arrowClass="ou-chatarrow" title="Open or close the questions" onToggle=${toggle}>
        <span class="ou-chatlabel">Ask Claude</span><span class=${counts.unread > 0 ? 'ou-chatcount ou-unread' : 'ou-chatcount'}>${line || null}</span>
      </${Disclosure}>
      <div class="ou-chatbody"><div class="ou-questions">${context.questions ? context.questions.view() : null}</div></div>
      <div class="ou-chatfoot">
        ${context.statusLight ? context.statusLight.hintView() : null}
        ${context.statusLight ? context.statusLight.whoView() : null}
        ${context.questions ? context.questions.askView() : null}
      </div>
    </section>`;
  }

  return {
    view,
    setOpen,
    setCounts,
    redraw,
    scrollToLatest,
    destroy: () => {
      window.removeEventListener('resize', onResize);
      sizeWatch?.disconnect();
    },
  };
}

export type ChatDock = ReturnType<typeof createChatDock>;
