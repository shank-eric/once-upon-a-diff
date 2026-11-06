/**
 * A request queue in one JSON file: build requests (builds.json) and fix requests (fixes.json). Each request is pending
 * until something finishes it, and a pending one is queued until a wait claims it for its session. Every write is a
 * locked read-modify-write (adapters/stores/fs/lock.ts), so the bridge and CLI processes can't lose each other's writes,
 * and a check and the write it decides (is it still pending? is it still queued?) happen in one step.
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson, withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';

/** What every queued request has. */
export interface Queued {
  id: string;
  status: string;
  requested_at: string;
  claimed_by?: string;
  claimed_at?: string;
  done_at?: string;
}

/**
 * A record as it is on disk with only the fields `change` altered applied to it: a field the check dropped or reshaped (a
 * newer writer's kind, one bad entry of a list) is written back as it was, unless this write meant to change it. An object
 * changed in place is merged the same way, against the object on disk, so a nested field the check dropped survives too.
 */
function merged(onDisk: unknown, was: unknown, now: unknown): unknown {
  if (!isRecord(was) || !isRecord(now)) {
    return now;
  }
  const record: Record<string, unknown> = isRecord(onDisk) ? { ...onDisk } : {};
  for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[field]) === JSON.stringify(now[field])) {
      continue;
    }
    if (field in now && now[field] !== undefined) {
      record[field] =
        isRecord(was[field]) && isRecord(now[field]) && isRecord(record[field])
          ? merged(record[field], was[field], now[field])
          : now[field];
    } else {
      delete record[field];
    }
  }
  return record;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The files already reported to have a record the check refuses, so a poll doesn't repeat it. */
const reported = new Set<string>();

export class RequestQueue<R extends Queued> {
  declare file: string;
  declare claimFreshMs: number | null;
  declare check: ((value: unknown) => R | null) | null;
  /**
   * `claimFreshMs`: how long a claim lasts with no refresh before the request is queued again; null, for good.
   * `check`: one of the contracts package's readers for the file's record (contracts/src/files/schemas.ts). A record it
   * refuses is invisible to this queue (never listed, claimed or finished) and is carried through every write untouched,
   * since a write rewrites the whole file. With no `check` every record is taken as it is.
   */
  constructor(
    file: string,
    {
      claimFreshMs,
      check = null,
    }: { claimFreshMs: number | null; check?: ((value: unknown) => R | null) | null },
  ) {
    this.file = file;
    this.claimFreshMs = claimFreshMs;
    this.check = check;
  }

  /** The records the check accepts, by key, from the file's parsed JSON (all of them with no check). */
  private accepted(raw: Record<string, unknown>): Record<string, R> {
    if (!this.check) {
      return raw as Record<string, R>;
    }
    const taken: Record<string, R> = {};
    for (const [key, value] of Object.entries(raw)) {
      const record = this.check(value);
      if (record) {
        taken[key] = record;
      }
    }
    if (Object.keys(taken).length < Object.keys(raw).length && !reported.has(this.file)) {
      reported.add(this.file);
      console.error(
        `${path.basename(this.file)}: ${Object.keys(raw).length - Object.keys(taken).length} record(s) do not match contracts/src/files/schemas.ts: left as they are, and not used`,
      );
    }
    return taken;
  }

  /** The requests by key, without the lock (a write is atomic, so a reader never sees half a file). */
  all(): Record<string, R> {
    return this.accepted(readJson<Record<string, unknown>>(this.file, {}) || {});
  }
  pending(): R[] {
    return Object.values(this.all()).filter((request) => request.status === 'pending');
  }
  /** Changes the requests in place under the file's lock, and returns what `change` returns. */
  update<T>(change: (all: Record<string, R>) => T): T {
    if (!this.check) {
      return updateJson<Record<string, R>, T>(this.file, {}, change);
    }
    return withLock(this.file, () => {
      const raw = readJson<Record<string, unknown>>(this.file, {}) ?? {};
      const taken = this.accepted(raw);
      const first = Object.keys(taken);
      // each accepted record as the check read it, to see which fields `change` altered, and the object itself: a record
      // `change` altered in place keeps what the check dropped, one it replaced with another object is that object whole
      const before = Object.fromEntries(first.map((key) => [key, JSON.stringify(taken[key])]));
      const held = Object.fromEntries(first.map((key) => [key, taken[key]]));
      const result = change(taken);
      const written: Record<string, unknown> = {};
      let changed = false;
      for (const key of Object.keys(raw)) {
        if (!(key in taken)) {
          if (first.includes(key)) {
            changed = true; // removed
          } else {
            written[key] = raw[key]; // a record the check refused stays as it was
          }
        } else if (!(key in before)) {
          written[key] = taken[key]; // a new request under the key of a refused record replaces it
          changed = true;
        } else if (JSON.stringify(taken[key]) === before[key]) {
          written[key] = raw[key];
        } else {
          written[key] =
            taken[key] === held[key]
              ? merged(raw[key], JSON.parse(before[key]), taken[key])
              : taken[key];
          changed = true;
        }
      }
      for (const key of Object.keys(taken)) {
        if (!(key in written) && !(key in raw)) {
          written[key] = taken[key];
          changed = true;
        }
      }
      if (changed) {
        writeJsonAtomic(this.file, written);
      }
      return result;
    });
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
      // in place: the record keeps whatever this reader did not take from it (see update)
      Object.assign(all[key], {
        claimed_by: consumer || all[key].claimed_by || 'cli',
        claimed_at: new Date().toISOString(),
      });
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
        Object.assign(all[key], { done_at: new Date().toISOString(), ...fields });
      }
      return all[key];
    });
  }
}
