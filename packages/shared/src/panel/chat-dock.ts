/*
 * The questions dock at the bottom of the panel: a header that opens and
 * closes it, and when open, the questions and answers (scrolling on their
 * own) over the Ask box. Its top edge drags to set its height. Open and
 * height are saved with the panel's state (chatOpen, chatHeight).
 *
 * The header says how many questions the step has, how many wait for an
 * answer, and "new answer" when one came while the dock was closed.
 */
import { plural } from '../util/text.ts';
import type { PanelContext } from './context.ts';

const MIN_HEIGHT = 120;
const MAX_HEIGHT_SHARE = 0.8; // of the panel's height
/** How close to the bottom (px) still counts as reading the latest, so a new answer scrolls into view. */
const PINNED_SLACK = 24;

export interface ChatCounts {
  open: number;
  waiting: number;
}

export function createChatDock(context: PanelContext) {
  const { state, opts, shell } = context;
  const { $, root } = shell;
  const dock = $('.ou-chat')!;
  const head = $<HTMLButtonElement>('.ou-chathead')!;
  const scroller = $('.ou-chatbody')!;
  let counts: ChatCounts = { open: 0, waiting: 0 };
  let unread = false;

  dock.hidden = !opts.ask && !opts.loadQuestions;

  function renderHead() {
    head.setAttribute('aria-expanded', String(state.chatOpen));
    $('.ou-chatarrow')!.textContent = state.chatOpen ? '▾' : '▸';
    const parts = [
      counts.open > 0 && plural(counts.open, 'question'),
      counts.waiting > 0 && `${counts.waiting} waiting`,
      unread && !state.chatOpen && 'new answer',
    ].filter(Boolean);
    const countLine = $('.ou-chatcount')!;
    countLine.textContent = parts.length ? parts.join(' · ') : '';
    countLine.classList.toggle('ou-unread', unread && !state.chatOpen);
  }

  function setHeight(height: number) {
    const max = Math.max(MIN_HEIGHT, root.clientHeight * MAX_HEIGHT_SHARE);
    state.chatHeight = Math.round(Math.min(Math.max(height, MIN_HEIGHT), max));
    dock.style.setProperty('--ou-chat-h', state.chatHeight + 'px');
  }

  function setOpen(open: boolean) {
    state.chatOpen = open;
    dock.classList.toggle('ou-open', open);
    if (open) {
      unread = false;
      setHeight(state.chatHeight);
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

  /** An answer came in: flag it on the header while the dock is closed. */
  function noteAnswer() {
    if (!state.chatOpen) {
      unread = true;
      renderHead();
    }
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
    const onPointerMove = (moveEvent: PointerEvent) => setHeight(bottom - moveEvent.clientY);
    const onPointerUp = () => {
      context.saveState();
      dock.classList.remove('ou-chat-dragging');
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', onPointerUp);
    };
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerUp);
  });

  const onResize = () => {
    if (state.chatOpen) {
      setHeight(state.chatHeight);
    }
  };
  window.addEventListener('resize', onResize);

  return {
    setOpen,
    setCounts,
    noteAnswer,
    redraw,
    scrollToLatest,
    destroy: () => window.removeEventListener('resize', onResize),
  };
}

export type ChatDock = ReturnType<typeof createChatDock>;
