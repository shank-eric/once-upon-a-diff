/**
 * A request queue in one JSON file: build requests (builds.json) and fix requests (fixes.json). Each request is pending
 * until something finishes it, and a pending one is queued until a wait claims it for its session. Every write is a
 * locked read-modify-write (adapters/stores/fs/lock.ts), so the bridge and CLI processes can't lose each other's writes,
 * and a check and the write it decides (is it still pending? is it still queued?) happen in one step.
 */
import { readJson } from '../../adapters/stores/fs/json-file.ts';
import { updateJson } from '../../adapters/stores/fs/lock.ts';

/** What every queued request has. */
export interface Queued {
  id: string;
  status: string;
  requested_at: string;
  claimed_by?: string;
  claimed_at?: string;
  done_at?: string;
}

export class RequestQueue<R extends Queued> {
  declare file: string;
  declare claimFreshMs: number | null;
  /** `claimFreshMs`: how long a claim lasts with no refresh before the request is queued again; null, for good. */
  constructor(file: string, { claimFreshMs }: { claimFreshMs: number | null }) {
    this.file = file;
    this.claimFreshMs = claimFreshMs;
  }

  /** The requests by key, without the lock (a write is atomic, so a reader never sees half a file). */
  all(): Record<string, R> {
    return readJson<Record<string, R>>(this.file, {}) || {};
  }
  pending(): R[] {
    return Object.values(this.all()).filter((request) => request.status === 'pending');
  }
  /** Changes the requests in place under the file's lock, and returns what `change` returns. */
  update<T>(change: (all: Record<string, R>) => T): T {
    return updateJson<Record<string, R>, T>(this.file, {}, change);
  }

  /** The key of the request with this id, or this key itself (any case), or null. */
  keyOf(all: Record<string, R>, idOrKey: string): string | null {
    const wanted = String(idOrKey).toLowerCase();
    return (
      Object.keys(all).find((k) => all[k].id === idOrKey || k.toLowerCase() === wanted) || null
    );
  }

  /** Pending and not claimed, or its claim went stale. */
  queued(request: R, now = Date.now()): boolean {
    if (request.status !== 'pending') {
      return false;
    }
    if (this.claimFreshMs === null) {
      return !request.claimed_by;
    }
    const since = Date.parse(request.claimed_at || '') || 0;
    return !(since && now - since < this.claimFreshMs);
  }

  /**
   * The queued requests `mine` accepts, oldest first, claimed for `consumer` in one write. A wait asks every few seconds,
   * so it looks without the lock first and takes it only when something is queued.
   */
  take(consumer: string, mine: (request: R) => boolean): R[] {
    if (!this.pending().some((request) => this.queued(request) && mine(request))) {
      return [];
    }
    return this.update((all) => {
      const now = Date.now();
      const taken = Object.values(all)
        .filter((request) => this.queued(request, now) && mine(request))
        .sort((first, second) => Date.parse(first.requested_at) - Date.parse(second.requested_at));
      for (const request of taken) {
        Object.assign(request, { claimed_by: consumer, claimed_at: new Date(now).toISOString() });
      }
      return taken;
    });
  }

  /** Claims (or refreshes the claim on) a pending request; null when there's no pending one by that id or key. */
  claim(idOrKey: string, consumer: string | null): R | null {
    return this.update((all) => {
      const key = this.keyOf(all, idOrKey);
      if (!key || all[key].status !== 'pending') {
        return null;
      }
      all[key] = {
        ...all[key],
        claimed_by: consumer || all[key].claimed_by || 'cli',
        claimed_at: new Date().toISOString(),
      };
      return all[key];
    });
  }

  /**
   * Finishes a request by id or key: `ending` gives its new status and fields, or null to leave it as it is (it says
   * whether the request, read under the lock, should end). Stamps done_at. Returns the request either way, or null when
   * there's none.
   */
  finish(idOrKey: string, ending: (request: R) => Partial<R> | null): R | null {
    return this.update((all) => {
      const key = this.keyOf(all, idOrKey);
      if (!key) {
        return null;
      }
      const fields = ending(all[key]);
      if (fields) {
        all[key] = { ...all[key], done_at: new Date().toISOString(), ...fields };
      }
      return all[key];
    });
  }
}
