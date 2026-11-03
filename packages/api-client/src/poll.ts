/*
 * A look at the bridge on a timer: the board's poll, with no framework in it so the panel can use it too (`use-poll.ts` is the
 * Preact hook over it). It loads at once, then every `everyMs` while the tab is visible, and when the window gets the focus
 * back. A failed load keeps the last data and counts the failures in a row, so a page can ride out one and say so at two.
 * `stop` ends it, and an answer that arrives after that is dropped, even when the poll has been started again since: each start is a run,
 * and only the run that asked hears the answer.
 */

/** What a poll has seen so far: the last data that loaded, the error of the latest failed load (null when it worked) and how many loads failed in a row. */
export interface PollView<T> {
  data: T | null;
  error: Error | null;
  failed: number;
}

export interface PollOptions<T> {
  load: () => Promise<T>;
  everyMs: number;
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
}

export function createPoll<T>({ load, everyMs, onChange }: PollOptions<T>): Poll {
  let view: PollView<T> = { data: null, error: null, failed: 0 };
  // the run that is going (0 when stopped): a load answers only to the run that started it
  let runs = 0;
  let current = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    const mine = current;
    if (!mine) {
      return;
    }
    let next: PollView<T>;
    try {
      next = { data: await load(), error: null, failed: 0 };
    } catch (err) {
      next = {
        data: view.data,
        error: err instanceof Error ? err : new Error(String(err)),
        failed: view.failed + 1,
      };
    }
    if (mine === current) {
      view = next;
      onChange(view);
    }
  }
  const onFocus = () => void refresh();

  return {
    start() {
      if (current) {
        return;
      }
      current = ++runs;
      void refresh();
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          void refresh();
        }
      }, everyMs);
      window.addEventListener('focus', onFocus);
    },
    stop() {
      current = 0;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    },
    refresh,
  };
}
