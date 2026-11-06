/*
 * A look at the bridge on a timer: the one poll of the board, the panel, the local page and the extension, with no framework in
 * it (`use-poll.ts` is the Preact hook over it). It loads at once, then `everyMs` after each load while the tab is visible, and
 * when the window gets the focus back. A failed load keeps the last data and counts the failures in a row, so a page can ride out one
 * and say so at two. `stop` ends it, and an answer that arrives after that is dropped, even when the poll has been started again
 * since: each start is a run, and only the run that asked hears the answer.
 *
 * A load that hasn't settled after LOAD_TIMEOUT_MS counts as a failed load ("timed out") and the next one is scheduled, so a
 * transport call that never settles can't end the poll. A `load` is given an AbortSignal, which the poll aborts when it gives
 * up on the load and when `stop` ends the run it belongs to: a load that passes it to the client's call (and so to the
 * transport's fetch) leaves no request open, so a route that hangs can't fill the browser's six connections to the host. The
 * abort is not a second failure: the timeout has already settled the load, and a load ended by `stop` is dropped. A load that
 * ignores the signal still can't end the poll, and its late answer is still dropped.
 *
 * `everyMs` may be a function, read before each wait: the wait it names, or null for none (the poll then sits idle until
 * `refresh` or `reschedule`). `whenHidden` turns it round, for a keepalive: it fires only while the tab is hidden, with no first
 * load and no focus listener.
 */

/** What a poll has seen so far: the last data that loaded, the error of the latest failed load (null when it worked) and how many loads failed in a row. */
export interface PollView<T> {
  data: T | null;
  error: Error | null;
  failed: number;
}

export interface PollOptions<T> {
  /** One look at the bridge. Pass `signal` on to the call it makes: the poll aborts it when the load times out or the poll stops. */
  load: (signal: AbortSignal) => Promise<T>;
  /** The wait between one load and the next, or a function that says it (null: no wait, idle until `refresh` or `reschedule`). */
  everyMs: number | (() => number | null);
  /** Fire only while the tab is hidden, with no load at start and none on focus. */
  whenHidden?: boolean;
  /** Called with each new view, after every load that finished. */
  onChange: (view: PollView<T>) => void;
}

export interface Poll {
  /** Loads now and starts the timer and the focus listener. */
  start: () => void;
  /** Ends the poll: no more loads, and an answer on its way is dropped. */
  stop: () => void;
  /** Loads now. Resolves once that load is in the view. Does nothing when the poll isn't running. */
  refresh: () => Promise<void>;
  /** Starts the wait again from now, reading `everyMs` anew: for when what a function interval says may have changed. */
  reschedule: () => void;
}

/** How long a load may take before the poll gives up on it: the slowest poll's interval (the 60 s keepalives), so no load is cut short that its own poll would still be waiting out. */
export const LOAD_TIMEOUT_MS = 60000;

export function createPoll<T>({
  load,
  everyMs,
  whenHidden = false,
  onChange,
}: PollOptions<T>): Poll {
  let view: PollView<T> = { data: null, error: null, failed: 0 };
  // the run that is going (0 when stopped): a load answers only to the run that started it
  let runs = 0;
  let current = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the loads out now: stop aborts them
  const out = new Set<AbortController>();

  async function refresh(): Promise<void> {
    const mine = current;
    if (!mine) {
      return;
    }
    let next: PollView<T>;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    out.add(controller);
    try {
      // the race settles once: a load that answers after the timeout lost it, and nothing reads its answer
      const data = await Promise.race([
        load(controller.signal),
        new Promise<never>((_resolve, reject) => {
          giveUp = setTimeout(() => {
            // the failure is the timeout's (rejected first); the abort only closes the request, and the load's own rejection is ignored
            reject(new Error(`load timed out after ${LOAD_TIMEOUT_MS / 1000} s`));
            controller.abort();
          }, LOAD_TIMEOUT_MS);
        }),
      ]);
      next = { data, error: null, failed: 0 };
    } catch (err) {
      next = {
        data: view.data,
        error: err instanceof Error ? err : new Error(String(err)),
        failed: view.failed + 1,
      };
    } finally {
      clearTimeout(giveUp);
      out.delete(controller);
    }
    if (mine === current) {
      view = next;
      try {
        onChange(view);
      } finally {
        schedule(); // a throwing onChange doesn't end the poll
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!current) {
      return;
    }
    const wait = typeof everyMs === 'function' ? everyMs() : everyMs;
    if (wait === null) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      const shown = document.visibilityState === 'visible';
      if (shown !== whenHidden) {
        void refresh();
      } else {
        schedule();
      }
    }, wait);
  }
  const onFocus = () => void refresh();

  return {
    start() {
      if (current) {
        return;
      }
      current = ++runs;
      if (whenHidden) {
        schedule();
        return;
      }
      void refresh();
      window.addEventListener('focus', onFocus);
    },
    stop() {
      current = 0;
      for (const controller of out) {
        controller.abort(); // a load of this run is over: its request closes, and its answer is dropped (current is 0)
      }
      out.clear();
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('focus', onFocus);
    },
    refresh,
    reschedule: schedule,
  };
}
