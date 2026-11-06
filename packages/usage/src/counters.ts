/*
 * What the bridge counts about use, apart from coverage: which routes were called (by which surface) and which UI-only
 * actions the pages reported, per ET day, in <home>/usage/actions.json. Names only, from closed lists: a route's key in
 * the contracts package's table (or `unmatched`), an action from domain/usage-actions.ts. Nothing a person typed can reach it.
 * Written within a few seconds of a count (a debounce), and at once on a flush (a signal, a shutdown).
 */
import { isActionName, MAX_ACTION_COUNT } from '@once-upon-a-diff/domain/usage-actions';
import { clearEpoch, readUsageJson, writeUsageJson } from './adapters/usage-file.ts';
import { etDay } from './days.ts';

export type Surface = 'board' | 'local' | 'local-view' | 'extension' | 'token';
/** What a call that matches no route is counted under, never its path. */
export const UNMATCHED = 'unmatched';
const KEEP_DAYS = 60;

export interface DayCounts {
  routes: Record<string, Record<string, number>>;
  ui: Record<string, Record<string, number>>;
  unknownDropped?: number;
}
export interface ActionsFile {
  since: string;
  updated: string;
  lastFlush: string;
  days: Record<string, DayCounts>;
}

const bump = (
  table: Record<string, Record<string, number>>,
  surface: string,
  key: string,
  amount = 1,
) => {
  const row = (table[surface] ||= {});
  row[key] = (row[key] ?? 0) + amount;
};

export class UsageCounters {
  private file: ActionsFile;
  private dirty = false;
  /** the `usage clear` count this file was loaded under, and when it was last looked at (ms) */
  private epoch: number;
  private epochChecked = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly home: string;
  private readonly routeKeys: ReadonlySet<string>;
  private readonly enabled: () => boolean;
  private readonly now: () => Date;
  private readonly debounceMs: number;

  constructor(
    home: string,
    routeKeys: ReadonlySet<string>,
    enabled: () => boolean,
    now: () => Date = () => new Date(),
    debounceMs = 5000,
  ) {
    this.home = home;
    this.routeKeys = routeKeys;
    this.enabled = enabled;
    this.now = now;
    this.debounceMs = debounceMs;
    this.epoch = clearEpoch(home);
    const stored = readUsageJson<Partial<ActionsFile>>(home, 'actions.json');
    const stamp = now().toISOString();
    this.file = {
      since: typeof stored?.since === 'string' ? stored.since : stamp,
      updated: typeof stored?.updated === 'string' ? stored.updated : stamp,
      lastFlush: typeof stored?.lastFlush === 'string' ? stored.lastFlush : stamp,
      days:
        stored?.days && typeof stored.days === 'object'
          ? (stored.days as Record<string, DayCounts>)
          : {},
    };
  }

  /** Whether counting is on now (the capture's mode, read from its settings). */
  counting(): boolean {
    return this.enabled();
  }

  /**
   * `usage clear` ran since this file was loaded: what is held was cleared, so it starts again empty rather than writing
   * the old days back. Looked at once a second while counting, and before every write.
   */
  private dropIfCleared(force = false): void {
    const nowMs = this.now().getTime();
    if (!force && nowMs - this.epochChecked < 1000 && nowMs >= this.epochChecked) {
      return;
    }
    this.epochChecked = nowMs;
    const epoch = clearEpoch(this.home);
    if (epoch === this.epoch) {
      return;
    }
    this.epoch = epoch;
    const stamp = this.now().toISOString();
    this.file = { since: stamp, updated: stamp, lastFlush: stamp, days: {} };
    this.dirty = false;
  }

  private today(): DayCounts {
    this.dropIfCleared();
    const day = etDay(this.now());
    return (this.file.days[day] ||= { routes: {}, ui: {} });
  }

  private touch(): void {
    this.dirty = true;
    this.file.updated = this.now().toISOString();
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
      this.timer.unref();
    }
  }

  /** One call to a route. An unknown key is counted as `unmatched`. */
  route(key: string | null, surface: Surface): void {
    if (!this.enabled()) {
      return;
    }
    bump(this.today().routes, surface, key && this.routeKeys.has(key) ? key : UNMATCHED);
    this.touch();
  }

  /** A page's batch: counts for listed actions, and how many names were dropped (not listed, or not a count in range). */
  actions(counts: Record<string, number>, surface: Surface): { kept: number; dropped: number } {
    let kept = 0;
    let dropped = 0;
    if (!this.enabled()) {
      return { kept, dropped };
    }
    const today = this.today();
    for (const [name, count] of Object.entries(counts)) {
      if (
        isActionName(name) &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= MAX_ACTION_COUNT
      ) {
        bump(today.ui, surface, name, count);
        kept++;
      } else {
        dropped++;
      }
    }
    if (dropped) {
      today.unknownDropped = (today.unknownDropped ?? 0) + dropped;
    }
    if (kept || dropped) {
      this.touch();
    }
    return { kept, dropped };
  }

  /** Writes the counts now. `stamp` writes even when nothing changed, so a reader waiting on a flush sees the answer. */
  flush(stamp = false): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dropIfCleared(true);
    if (!this.dirty && !stamp) {
      return;
    }
    const cutoff = etDay(this.now().getTime() - KEEP_DAYS * 86400000);
    for (const day of Object.keys(this.file.days)) {
      if (day < cutoff) {
        delete this.file.days[day];
      }
    }
    this.file.lastFlush = this.now().toISOString();
    try {
      writeUsageJson(this.home, 'actions.json', this.file);
      this.dirty = false;
    } catch {
      /* a home that can't be written: counts stay in memory, the next flush tries again */
    }
  }
}
