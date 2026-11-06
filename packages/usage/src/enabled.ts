/*
 * Whether the bridge should count a call or a batch right now: the capture is on in this process (the shim started it, or a
 * test forces it with ONCE_UPON_USAGE=force) and neither ONCE_UPON_USAGE=0 nor usage/settings.json says off. The
 * settings file is re-read at most every 5 seconds, so `usage off` takes effect quickly without a stat per request.
 */
import { isRunning, readMode } from './adapters/session.ts';

const CACHE_MS = 5000;

export function countingEnabled(home: string): () => boolean {
  let checked = 0;
  let value = false;
  return () => {
    const now = Date.now();
    if (now - checked > CACHE_MS) {
      checked = now;
      value = (isRunning() || process.env.ONCE_UPON_USAGE === 'force') && readMode(home) !== 'off';
    }
    return value;
  };
}
