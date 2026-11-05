/*
 * The Preact hook over `createPoll` (./poll.ts), for a component that shows what the bridge says and keeps it current:
 *
 *   const { data, error, failed, refresh } = usePoll((signal) => bridge.ask(ROUTES.board, undefined, { signal }), { everyMs: 3000 });
 *
 * `data` is null until the first load and then the last one that worked, `error` the latest failure (null when the last load
 * worked) and `failed` the failures in a row. `refresh()` loads now. `load` is given the poll's AbortSignal (see poll.ts): pass it on to the call. The component may pass a new `load` function on every
 * redraw: the poll calls the latest one and its timer is not restarted. It stops when the component goes.
 * It imports Preact as the pages do (/assets/preact.mjs, which the bridge serves), so only a page loads this file.
 */
import { useCallback, useLayoutEffect, useRef, useState } from '/assets/preact.mjs';
import { createPoll, type Poll, type PollView } from './poll.ts';

export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: { everyMs: number },
): PollView<T> & { refresh: () => Promise<void> } {
  const { everyMs } = options;
  const [view, setView] = useState<PollView<T>>({ data: null, error: null, failed: 0 });
  const latest = useRef(load);
  latest.current = load;
  const poll = useRef<Poll | null>(null);
  // a layout effect, so the first load starts with the first draw and not after the next paint
  useLayoutEffect(() => {
    const started = createPoll<T>({
      load: (signal) => latest.current(signal),
      everyMs,
      onChange: setView,
    });
    poll.current = started;
    started.start();
    return () => {
      started.stop();
      poll.current = null;
    };
  }, [everyMs]);
  const refresh = useCallback(() => poll.current?.refresh() ?? Promise.resolve(), []);
  return { ...view, refresh };
}
