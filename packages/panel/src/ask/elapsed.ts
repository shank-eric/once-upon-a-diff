/*
 * How long a session has been on a question, counting up on its own: only this span redraws each second, not the panel. The
 * questions part owns the clock (it stops it when the panel is closed), and this subscribes to it while it is on screen.
 */
import { html, useEffect, useState } from '/assets/preact.mjs';
import { elapsedText } from './question-list.ts';

/** Ticks every second while the tab shows. `subscribe` answers a function that stops listening. */
export interface Clock {
  subscribe(listener: () => void): () => void;
}

export function Elapsed({ since, clock }: { since: string; clock: Clock }) {
  const [, setTick] = useState(0);
  useEffect(() => clock.subscribe(() => setTick((tick: number) => tick + 1)), [clock]);
  return html`<span class="ou-elapsed" data-since=${since}>${elapsedText(Date.now() - Date.parse(since))}</span>`;
}
