import { monitorEventLoopDelay } from 'node:perf_hooks';

/** One process-wide histogram of how late the event loop's timer ticks ran: a sync call anywhere in the bridge shows here. */
const histogram = monitorEventLoopDelay({ resolution: 10 });

/** The longest and 99th-percentile delay (ms) since the last call, then starts over. The first call starts the probe. */
export function takeLoopDelay(): { max: number; p99: number } {
  const taken = {
    max: Math.round(histogram.max / 1e6),
    p99: Math.round(histogram.percentile(99) / 1e6),
  };
  histogram.reset();
  histogram.enable();
  return taken;
}
