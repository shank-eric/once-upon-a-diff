/*
 * The one tiny counter API a page, the panel or the extension uses for the usage capture: `count('board.tab.switch')`.
 * The name has to be one of the protocol's ACTIONS (the type says so, and the bridge drops anything else), so what is sent
 * is a name and a count, never text. Counts are batched in memory and sent as one call at most once a minute (and when the
 * host asks, as the tab is hidden); a batch that did not get through is kept for the next one, and when the bridge says
 * the capture is off the counter stops. This file does no I/O of its own: `send` is the host's call to the bridge.
 */
import type { ActionName, UsageAnswer } from '@once-upon-a-diff/domain/usage-actions';

/** Sends a batch; resolves to the bridge's answer, or null when it did not get there. */
export type SendCounts = (counts: Record<string, number>) => Promise<UsageAnswer | null>;

const EVERY_MS = 60_000;
/** Names kept while the bridge is down, so a long outage cannot grow the batch without bound. */
const MAX_PENDING = 200;

export function createUsage(send: SendCounts, everyMs = EVERY_MS) {
  let pending: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off = false;
  let sending = false;

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (off || sending || Object.keys(pending).length === 0) {
      return;
    }
    const batch = pending;
    pending = {};
    sending = true;
    let answer: UsageAnswer | null = null;
    try {
      answer = await send(batch);
    } catch {
      answer = null;
    }
    sending = false;
    if (answer && answer.on === false) {
      off = true;
      pending = {};
      return;
    }
    if (!answer) {
      // not delivered: put it back for the next try
      for (const [name, total] of Object.entries(batch)) {
        if (name in pending || Object.keys(pending).length < MAX_PENDING) {
          pending[name] = (pending[name] ?? 0) + total;
        }
      }
      schedule();
    }
  }

  function schedule() {
    if (!timer && !off) {
      timer = setTimeout(() => void flush(), everyMs);
    }
  }

  return {
    /** Counts one use of a UI-only action. */
    count(name: ActionName): void {
      if (off) {
        return;
      }
      pending[name] = (pending[name] ?? 0) + 1;
      schedule();
    },
    /** Sends what is pending now (the tab is being hidden). */
    flush,
  };
}

export type Usage = ReturnType<typeof createUsage>;
