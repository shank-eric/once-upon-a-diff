/*
 * The local page's two timers, both createPolls (/assets/api-client/poll.ts): the version check while the panel is closed
 * (the open panel's own tick looks then), every 5 s while the tab shows and when it gets focus; and the "still open" keepalive,
 * about once a minute while the tab is hidden (services/inbox/auto-stop.ts).
 */
import { createPoll } from '/assets/api-client/poll.ts';

export const POLL_MS = 5000;
export const STILL_OPEN_MS = 60000;

/** Starts both. `closed` says whether the panel is closed, `reload` looks for a new version, `seen` tells the bridge the page is open. Returns the stop. */
export function startLocalPolls({
  closed,
  reload,
  seen,
}: {
  closed: () => boolean;
  reload: () => Promise<void> | void;
  seen: () => Promise<unknown>;
}) {
  const whileClosed = createPoll<void>({
    everyMs: POLL_MS,
    load: async () => {
      if (closed()) {
        await reload();
      }
    },
    onChange: () => {},
  });
  const stillOpen = createPoll<void>({
    everyMs: STILL_OPEN_MS,
    whenHidden: true,
    load: async () => void (await seen()),
    onChange: () => {},
  });
  whileClosed.start();
  stillOpen.start();
  return () => {
    whileClosed.stop();
    stillOpen.stop();
  };
}
