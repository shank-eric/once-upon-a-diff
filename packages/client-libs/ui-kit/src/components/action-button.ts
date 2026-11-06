/*
 * ActionButton and useBusy: a click that starts something that takes a while. The button is off, and says `busyLabel`, until the
 * work it started is done. `useBusy` is the same thing without the button, for work a handler starts (`run`): a second call while
 * one is out is ignored, and the key is cleared however the work ends. Neither catches: the work says its own failures (an alert,
 * a note) and does its own refresh, because what a failure does differs from one place to the next.
 */
import { html, useRef, useState } from '/assets/preact.mjs';

/** The key of the work that is out (null when none), and `run`, which starts work under a key unless some is out. */
export function useBusy(): {
  busy: string | null;
  run: (key: string, work: () => Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  // a ref too: a second call in the same tick as the first has not seen the state change yet
  const out = useRef(false);
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (out.current) {
      return;
    }
    out.current = true;
    setBusy(key);
    try {
      await work();
    } finally {
      out.current = false;
      setBusy(null);
    }
  };
  return { busy, run };
}

export function ActionButton(props: {
  /** What a click starts. The button is busy while the promise it returns is pending. */
  onClick: () => Promise<unknown> | void;
  /** The label while busy; the button keeps its children when none is given. */
  busyLabel?: string;
  /** Off for a reason of the caller's own (it is off while busy either way). */
  disabled?: boolean;
  title?: string;
  class?: string;
  /** More attributes for the button (data-*). */
  attrs?: Record<string, unknown>;
  children?: unknown;
}) {
  const { onClick, busyLabel, disabled, title, class: className, attrs, children } = props;
  const { busy, run } = useBusy();
  const working = busy !== null;
  return html`<button type="button" class=${className} title=${title} ...${attrs} disabled=${working || !!disabled} onClick=${() => run('click', async () => onClick())}>${working && busyLabel ? busyLabel : children}</button>`;
}
