/*
 * How long a session has been on something, counting up on its own: only this span redraws each second, not the page. The
 * caller owns the clock (it stops it when the page is closed), and this subscribes to it while it is on screen.
 */
import { html, useEffect, useState } from '/assets/preact.mjs';
import { elapsedText } from '@once-upon-a-diff/terms/time';

/** Ticks every second while the tab shows. `subscribe` answers a function that stops listening. */
export interface Clock {
  subscribe(listener: () => void): () => void;
}

export function Elapsed({
  since,
  clock,
  class: className = 'ou-ui-elapsed',
}: {
  since: string;
  clock: Clock;
  /** The class the span carries: a host with its own look for it (the panel's `ou-elapsed`) names it. */
  class?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => clock.subscribe(() => setTick((tick: number) => tick + 1)), [clock]);
  return html`<span class=${className} data-since=${since}>${elapsedText(Date.now() - Date.parse(since))}</span>`;
}
