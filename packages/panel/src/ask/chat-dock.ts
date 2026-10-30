/*
 * The questions dock at the bottom of the panel: a header that opens and
 * closes it, and when open, the questions and answers (scrolling on their
 * own) over the Ask box. Its top edge drags to set its height. Open and
 * height are saved with the panel's state (chatOpen, chatHeight).
 *
 * The header says how many questions the story has, how many a session is
 * working on or waits for one, and how many answers nobody has read. The
 * bridge keeps what was read, so the count holds across reloads and pages.
 */
import { plural } from '@once-upon-a-diff/shared/util/text';
import type { PanelContext } from '../context.ts';
import { dockHeightWithin } from '../layout.ts';

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
  const dock = $('.ou-chat')!;
  const head = $<HTMLButtonElement>('.ou-chathead')!;
  const scroller = $('.ou-chatbody')!;
  let counts: ChatCounts = { open: 0, waiting: 0, working: 0, unread: 0 };

  dock.hidden = !opts.ask && !opts.loadQuestions;

  function renderHead() {
    head.setAttribute('aria-expanded', String(state.chatOpen));
    $('.ou-chatarrow')!.textContent = state.chatOpen ? '▾' : '▸';
    const parts = [
      counts.open > 0 && plural(counts.open, 'question'),
      counts.working > 0 && `${counts.working} being worked on`,
      counts.waiting > 0 && `${counts.waiting} waiting`,
      counts.unread > 0 && `${counts.unread} unread ${counts.unread === 1 ? 'answer' : 'answers'}`,
    ].filter(Boolean);
    const countLine = $('.ou-chatcount')!;
    countLine.textContent = parts.length ? parts.join(' · ') : '';
    countLine.classList.toggle('ou-unread', counts.unread > 0);
  }

  /**
   * Shows the dock at height, kept within the panel, and returns what it showed. The saved height (state.chatHeight)
   * is the reader's: only a drag changes it, so a small window or a panel not laid out yet can't shrink it for good.
   * A panel whose stylesheet hasn't loaded yet has no real height to be kept within, so the panel's resizes
   * (the stylesheet arriving, the window changing) show it again.
   */
  function showHeight(height: number) {
    const shown = dockHeightWithin(height, root.clientHeight);
    dock.style.setProperty('--ou-chat-h', shown + 'px');
    return shown;
  }

  function setOpen(open: boolean) {
    state.chatOpen = open;
    dock.classList.toggle('ou-open', open);
    if (open) {
      showHeight(state.chatHeight);
      scrollToLatest();
    }
    renderHead();
  }

  function scrollToLatest() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  /** Is the conversation scrolled to (about) its end? */
  function isPinned() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_SLACK;
  }

  /** Redraws the conversation through draw, keeping you at the end if you were there. */
  function redraw(draw: () => void) {
    const pinned = isPinned();
    draw();
    if (pinned) {
      scrollToLatest();
    }
  }

  function setCounts(next: ChatCounts) {
    counts = next;
    renderHead();
  }

  head.addEventListener('click', () => {
    setOpen(!state.chatOpen);
    context.saveState();
    if (state.chatOpen) {
      $<HTMLTextAreaElement>('.ou-ask textarea')?.focus();
    }
  });

  // resize by dragging the top edge
  $('.ou-chatgrip')!.addEventListener('pointerdown', (event) => {
    if (!state.chatOpen) {
      return;
    }
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    dock.classList.add('ou-chat-dragging');
    const bottom = dock.getBoundingClientRect().bottom;
    const onPointerMove = (moveEvent: PointerEvent) => {
      state.chatHeight = showHeight(bottom - moveEvent.clientY);
    };
    const onPointerUp = () => {
      context.saveState();
      opts.onLayout?.({ chatHeight: state.chatHeight });
      dock.classList.remove('ou-chat-dragging');
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', onPointerUp);
    };
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerUp);
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

  return {
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
