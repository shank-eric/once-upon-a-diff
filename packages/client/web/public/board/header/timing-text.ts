/** The board's timing tooltip: how long the bridge's last build took (its Server-Timing header), the machine's load, and the page's own poll gap and round trip. */

/** What the bridge said of its last build. */
export interface ServerTiming {
  buildMs: number;
  load: number | null;
}

/** What this page measured of its own polls: ms from the end of the previous request to the start of this one, and this request's round trip. */
export interface PollTiming {
  gapMs: number | null;
  tookMs: number | null;
  /** The tab was hidden during the gap, so a long gap is the tab resting, not stalling. */
  hiddenInGap?: boolean;
}

/** A poll's timing plus what is needed to measure the next one. */
export interface PollLog extends PollTiming {
  lastEnd: number | null;
  /** Set while the tab is hidden; a poll start moves it into `hiddenInGap` and clears it. */
  hiddenSince: boolean;
}

export const newPollLog = (): PollLog => ({
  gapMs: null,
  tookMs: null,
  hiddenInGap: false,
  lastEnd: null,
  hiddenSince: false,
});

/** A request starts: the gap runs from the previous request's end, so the previous request's own time is not counted again. */
export function pollStarted(log: PollLog, now: number): void {
  log.gapMs = log.lastEnd === null ? null : now - log.lastEnd;
  log.hiddenInGap = log.hiddenSince;
  log.hiddenSince = false;
}

/** A request answered (or failed): its round trip, and where the next gap starts. */
export function pollEnded(log: PollLog, startedAt: number, now: number): void {
  log.tookMs = now - startedAt;
  log.lastEnd = now;
}

/** Reads `build;dur=120, load;desc="2.31"`; null when there is no build entry (an older bridge). */
export function parseServerTiming(header: string | null): ServerTiming | null {
  const build = header?.match(/build;dur=(\d+(?:\.\d+)?)/);
  if (!build) {
    return null;
  }
  const load = header?.match(/load;desc="?(\d+(?:\.\d+)?)/);
  return { buildMs: Number(build[1]), load: load ? Number(load[1]) : null };
}

const seconds = (millis: number) => `${(millis / 1000).toFixed(1)} s`;
const span = (millis: number) => (millis < 1000 ? `${Math.round(millis)} ms` : seconds(millis));

/** The tooltip's text, empty when nothing is known yet. */
export function timingText(server: ServerTiming | null, poll: PollTiming): string {
  const parts = [
    ...(server
      ? [
          `bridge build ${span(server.buildMs)}`,
          ...(server.load === null ? [] : [`load ${server.load.toFixed(2)}`]),
        ]
      : []),
    ...(poll.tookMs === null ? [] : [`request ${span(poll.tookMs)}`]),
    ...(poll.gapMs === null
      ? []
      : [`${seconds(poll.gapMs)} between polls${poll.hiddenInGap ? ' (tab was hidden)' : ''}`]),
  ];
  return parts.join(' · ');
}
