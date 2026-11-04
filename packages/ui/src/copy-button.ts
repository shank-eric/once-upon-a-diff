/*
 * A Copy button: a click puts `text` on the clipboard and the label says "Copied" for a moment, then goes back by itself. When the
 * page has no clipboard or it refuses, `onFailed` (the caller's own way to get the text out, such as selecting it) runs and may
 * answer the label to show instead. Nothing is shown when it answers nothing.
 */
import { html, useEffect, useRef, useState } from '/assets/preact.mjs';
import { writeClipboard } from './clipboard.ts';

/** How long a label says how a copy went. */
export const COPIED_LABEL_MS = 1500;

/** A label that says how a copy went for `delay` milliseconds, then is null again. `say` shows one; a timer left over is stopped when the component goes. */
export function useCopied(delay = COPIED_LABEL_MS): [string | null, (label: string) => void] {
  const [label, setLabel] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = (next: string) => {
    clearTimeout(timer.current);
    setLabel(next);
    timer.current = setTimeout(() => setLabel(null), delay);
  };
  return [label, say];
}

export function CopyButton(props: {
  text: string;
  /** The button's label until a copy has gone by. */
  children?: unknown;
  /** The label after a copy that worked. */
  copiedLabel?: string;
  /** Runs when the clipboard took the text. */
  onCopied?: () => void;
  /** Runs when the clipboard said no. It may answer the label to show for a moment. */
  onFailed?: () => string | void;
  class?: string;
  title?: string;
  /** More attributes for the button (data-*). */
  attrs?: Record<string, unknown>;
}) {
  const {
    text,
    children,
    copiedLabel = 'Copied',
    onCopied,
    onFailed,
    class: className,
    title,
    attrs,
  } = props;
  const [label, say] = useCopied();
  const copy = async () => {
    if (await writeClipboard(text)) {
      onCopied?.();
      say(copiedLabel);
      return;
    }
    const shown = onFailed?.();
    if (shown) {
      say(shown);
    }
  };
  return html`<button type="button" class=${className} title=${title} ...${attrs} onClick=${copy}>${label ?? children}</button>`;
}
