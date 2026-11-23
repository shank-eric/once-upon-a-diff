/*
 * A background look that finds the world changed (an iTerm tab opened, a spoken line arrived) says so here, and the board
 * drops its kept snapshot, so the next poll shows it instead of the one after. The adapters know nothing of the board:
 * it subscribes, they announce.
 */
const listeners = new Set<() => void>();

/** Calls `listener` whenever a background look finds a change. Returns what stops it. */
export function onBackgroundChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A background look found something different from what was kept. */
export function announceChange(): void {
  for (const listener of listeners) {
    listener();
  }
}
