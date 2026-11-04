/*
 * The board's voice session, the first region drawn by Preact (ADR-14). The rest of the page is still strings that
 * board.ts puts in with innerHTML; this one is a component that board.ts renders into a host element of its own, with
 * the 3 s poll's `voice` as a prop. Preact diffs it, so a poll never replaces the grip (and its focus), the conversation
 * (and its scroll) or the Pause button, and what the panel remembers lives here, not in the page's module state.
 *
 * It is a tab on the right edge that opens a docked panel: repo and branch, status, context, agents, the conversation
 * (newest at the bottom) and Open in iTerm. While voice is paused or ended the panel is collapsed to its tab, and the tab
 * peeks it open without remembering. The panel's width is dragged (or arrowed) and remembered. The board's own element
 * (`root`) carries the classes and the width variable the stylesheet makes room with.
 */
import { html, render, useEffect, useLayoutEffect, useRef, useState } from '/assets/preact.mjs';
import { remember, stored } from '/assets/local/stored.ts';
import { Meter } from '/assets/ui/meter.ts';
import type { BoardVoice, BoardVoiceLine } from '/assets/types.ts';

const OPEN_KEY = 'ou-board-voice-open';
const WIDTH_KEY = 'ou-board-voice-width';
export const MIN_WIDTH = 260;
const MAX_SHARE = 0.6;
const KEY_STEP = 16;
/** How near the bottom still counts as at the bottom, in px. */
const BOTTOM_SLACK = 8;

const STATUS: Record<BoardVoice['status'], string> = {
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Working',
  paused: 'Paused',
  away: 'Away on the phone',
  ended: 'Ended',
};

/** A width kept between the least the panel is usable at and the share of the window it may take. */
export const clampWidth = (width: number, viewport: number) =>
  Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(viewport * MAX_SHARE, MIN_WIDTH)));

/** Whether a scroller is at its bottom (so a new line should scroll into view). */
export const nearBottom = (scrollHeight: number, scrollTop: number, clientHeight: number) =>
  scrollHeight - scrollTop - clientHeight < BOTTOM_SLACK;

/** While voice is paused or ended the panel is collapsed to its tab. */
export const isCollapsed = (voice: BoardVoice) =>
  voice.status === 'paused' || voice.status === 'ended';

/**
 * A key for each conversation line that stays with it as the window slides (the bridge keeps the last 20): when it was
 * said and by whom, and a count for the rare repeat of both. Keyed by position, every new line past 20 would rewrite
 * every item's text and drop a text selection.
 */
export function lineKeys(lines: readonly BoardVoiceLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.at}-${line.who}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}#${count}` : base;
  });
}

const MicIcon = () =>
  html`<svg class="ou-board-voice-mic" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="currentColor" d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Z"/>
    <path fill="currentColor" d="M3.5 7a.75.75 0 0 1 1.5 0 3 3 0 0 0 6 0 .75.75 0 0 1 1.5 0 4.5 4.5 0 0 1-3.75 4.44V14h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-2.56A4.5 4.5 0 0 1 3.5 7Z"/>
  </svg>`;

export type VoicePanelProps = {
  /** The poll's voice session, or null when voice is off (nothing is drawn). */
  voice: BoardVoice | null;
  /** The board's own element: it gets the has-voice and pushed classes and the width variable. */
  root: HTMLElement;
  /** Pauses (true) or resumes (false) the voice session, through the bridge. */
  pause: (paused: boolean) => Promise<unknown>;
  /** Called after Pause or Resume, to poll again. */
  onChanged: () => void | Promise<void>;
  /** Brings the voice session's iTerm tab to the front. */
  onFocus: (session: string) => Promise<void>;
};

export function VoicePanel(props: VoicePanelProps) {
  const { voice, root, pause: askPause, onChanged, onFocus } = props;
  const [open, setOpen] = useState(() => stored(OPEN_KEY, false, (text) => text === 'true'));
  const [peek, setPeek] = useState(false);
  const [width, setWidth] = useState<number | null>(() =>
    stored<number | null>(WIDTH_KEY, null, (text) => {
      const saved = Number.parseInt(text);
      return Number.isFinite(saved) ? saved : null;
    }),
  );
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  const grip = useRef<HTMLElement | null>(null);
  const lines = useRef<HTMLElement | null>(null);
  /** The conversation was at its bottom when last looked at, so a new line scrolls into view. */
  const stick = useRef(true);
  const dragging = useRef(false);
  const widthNow = useRef(width);

  const collapsed = !!voice && isCollapsed(voice);
  const shown = !!voice && (collapsed ? peek : open);

  // a peek only lasts while the panel is collapsed
  useEffect(() => {
    if (!collapsed) {
      setPeek(false);
    }
  }, [collapsed]);

  // the stylesheet makes room beside the board, and sizes the panel, from the board's own element
  useLayoutEffect(() => {
    root.classList.toggle('ou-board-has-voice', !!voice);
    root.classList.toggle('ou-board-pushed', shown);
    if (width === null) {
      root.style.removeProperty('--ou-voice-width');
    } else {
      root.style.setProperty('--ou-voice-width', `${width}px`);
    }
  }, [root, !!voice, shown, width]);

  // the grip reports the width it is at
  useLayoutEffect(() => {
    if (grip.current && panel.current) {
      grip.current.setAttribute(
        'aria-valuenow',
        String(Math.round(panel.current.getBoundingClientRect().width)),
      );
    }
  }, [shown, width]);

  // a new line (a new last key) scrolls the conversation to the bottom if it was there; otherwise it stays where it is
  const keys = voice ? lineKeys(voice.lines) : [];
  const lastKey = keys.at(-1);
  useLayoutEffect(() => {
    if (!shown) {
      stick.current = true;
    } else if (lines.current && stick.current) {
      lines.current.scrollTop = lines.current.scrollHeight;
    }
  }, [shown, keys.length, lastKey]);

  const resize = (next: number) => {
    widthNow.current = next;
    setWidth(next);
  };
  const saveWidth = () => {
    if (widthNow.current !== null) {
      remember(WIDTH_KEY, String(widthNow.current));
    }
  };
  // the grip is gone (voice paused, ended or off) mid-drag, so no pointerup will come: end the drag here
  useLayoutEffect(() => {
    if (!shown && dragging.current) {
      dragging.current = false;
      saveWidth();
    }
  }, [shown]);

  if (!voice) {
    return null;
  }
  const toggle = () => {
    if (collapsed) {
      setPeek(!peek);
    } else {
      setOpen(!open);
      remember(OPEN_KEY, String(!open));
    }
  };
  const pause = async (paused: boolean) => {
    setBusy(true);
    try {
      await askPause(paused);
    } catch (err) {
      alert(`Couldn't ${paused ? 'pause' : 'resume'} voice: ${(err as Error).message}`);
    }
    try {
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const focusTab = async () => {
    setSwitching(true);
    try {
      await onFocus(voice.session);
    } finally {
      setSwitching(false);
    }
  };

  const status = STATUS[voice.status];
  const agents = [
    voice.agents.running && `${voice.agents.running} running`,
    voice.agents.waiting && `${voice.agents.waiting} waiting`,
    voice.agents.review && `${voice.agents.review} ready for review`,
  ]
    .filter(Boolean)
    .join(', ');
  const where = voice.repo
    ? `${voice.repo.split('/')[1]}${voice.branch ? ` · ${voice.branch}` : ''}`
    : '';
  const openVerb = collapsed ? 'Peek at' : 'Open';
  const tabVerb = shown ? 'Close' : openVerb;
  const focusTitle = voice.can_focus
    ? "Bring the voice session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';

  const resumeTitle = 'Resume voice (removes ~/.larmor/paused, as the menu bar does)';
  const pauseTitle = 'Pause voice (the mic is released until you resume)';
  const pauseButton = (() => {
    if (voice.status === 'ended') {
      return null;
    }
    const paused = voice.status === 'paused';
    return html`<button type="button" class="ou-board-voice-pause" disabled=${busy} onClick=${() => pause(!paused)} title=${paused ? resumeTitle : pauseTitle}>${paused ? 'Resume' : 'Pause'}</button>`;
  })();

  const gripKeys = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    // ArrowLeft widens the panel (its edge moves left), ArrowRight narrows it, KEY_STEP at a time
    const current = panel.current ? panel.current.getBoundingClientRect().width : MIN_WIDTH;
    const base = widthNow.current === null ? current : Math.min(widthNow.current, current);
    resize(
      clampWidth(base + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP), window.innerWidth),
    );
    saveWidth();
  };
  // pointer capture keeps a drag going when the pointer leaves the thin handle
  const gripDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging.current = true;
  };
  const gripUp = () => {
    if (dragging.current) {
      dragging.current = false;
      saveWidth();
    }
  };
  const gripMove = (event: PointerEvent) => {
    if (!dragging.current) {
      return;
    }
    // the button came up where no pointerup reached us: the drag is over
    if (event.buttons === 0) {
      gripUp();
      return;
    }
    resize(clampWidth(window.innerWidth - event.clientX, window.innerWidth));
  };

  return html`<aside class=${`ou-board-voice ou-board-voice-${voice.status}${shown ? ' ou-board-voice-open' : ''}${collapsed ? ' ou-board-voice-collapsed' : ''}`} aria-label="Voice session">
    <button type="button" class="ou-board-voice-tab" onClick=${toggle} aria-expanded=${String(shown)} aria-controls="ou-board-voice-panel" title=${`${tabVerb} the voice session: ${voice.name}`}>
      <${MicIcon} /><span class="ou-board-voice-dot" aria-hidden="true"></span><span class="ou-board-voice-word">${status}</span>
    </button>
    ${
      shown
        ? html`<div class="ou-board-voice-panel" id="ou-board-voice-panel" role="region" aria-label="Voice session panel" ref=${panel}>
      <div class="ou-board-voice-grip" ref=${grip} role="separator" aria-orientation="vertical" aria-label="Resize the voice panel" aria-valuemin=${MIN_WIDTH} tabindex="0"
        title="Drag to resize (or use the arrow keys)" onPointerDown=${gripDown} onPointerMove=${gripMove} onPointerUp=${gripUp} onPointerCancel=${gripUp} onLostPointerCapture=${gripUp} onKeyDown=${gripKeys}></div>
      <div class="ou-board-voice-head">
        <strong class="ou-board-voice-name" title=${voice.title}>${voice.name}</strong>
        <button type="button" class="ou-board-voice-close" onClick=${toggle} aria-label="Close the voice panel" title="Close">✕</button>
      </div>
      ${where ? html`<div class="ou-local-muted">${where}</div>` : null}
      <div class="ou-board-voice-facts">
        <span class="ou-board-voice-status"><span class="ou-board-voice-dot" aria-hidden="true"></span>${status}</span>${typeof voice.context === 'number' ? html` <${Meter} label="ctx" percent=${voice.context} title=${`The session's context window is ${Math.round(voice.context)}% full`} />` : null}${pauseButton}
      </div>
      <div class="ou-local-muted">${agents ? `agents: ${agents}` : 'no agents running'}</div>
      ${
        voice.lines.length > 0
          ? html`<ol class="ou-board-voice-lines" aria-label="Conversation, newest last" ref=${lines} onScroll=${(
              event: Event,
            ) => {
              const list = event.currentTarget as HTMLElement;
              stick.current = nearBottom(list.scrollHeight, list.scrollTop, list.clientHeight);
            }}>${voice.lines.map((line, index) => html`<li key=${keys[index]} class=${`ou-board-voice-${line.who}`}><span class="ou-local-muted">${line.who === 'you' ? 'You' : 'Voice'}</span> ${line.text}</li>`)}</ol>`
          : html`<p class="ou-local-muted ou-board-voice-none">Nothing said yet.</p>`
      }
      <button type="button" class="ou-board-focus" disabled=${!voice.can_focus || switching} onClick=${focusTab} title=${focusTitle}>${switching ? 'Switching…' : 'Open in iTerm'}</button>
    </div>`
        : null
    }
  </aside>`;
}

/** Draws (or updates, or with a null voice clears) the voice session in host, a stable element the page's string render never touches. */
export function mountVoice(host: HTMLElement, props: VoicePanelProps): void {
  render(html`<${VoicePanel} ...${props} />`, host);
}
