/*
 * The stored coverage (usage/coverage-bridge.json, coverage-cli.json) and how a new take is merged into it: per file and
 * version (sha), the lines no run has covered yet. Pure.
 */
import { andBits, countBits, fromBase64, toBase64 } from './lines.ts';

/** How many versions (shas) of one path are kept: a deploy changes a file, and the oldest goes. */
export const MAX_VERSIONS = 3;

/** One version of one file. `uncovered` is a base64 bitset, one bit per line, set when no take ever ran the line. */
export interface CoverageEntry {
  sha: string;
  /** 'function' (whole functions) or 'lines' (block ranges): the coarser of what was merged */
  mode: 'function' | 'lines';
  lines: number;
  uncovered: string;
  firstSeen: string;
  lastSeen: string;
  /** how many takes had this file */
  takes: number;
  /** the uncovered-line count at the end of each day it was seen, to show coverage growing */
  dayUncovered: Record<string, number>;
}

/** What one process saw of one file. */
export interface Seen {
  path: string;
  sha: string;
  mode: 'function' | 'lines';
  lines: number;
  uncovered: Uint8Array;
}

export interface CoverageFile {
  since: string;
  updated: string;
  /** the last time the process that writes this file flushed, changed or not (a signal asks for one) */
  lastFlush: string;
  /** how many processes contributed (bridge restarts, or CLI runs that added something) */
  starts: number;
  files: Record<string, CoverageEntry[]>;
}

export const emptyCoverage = (now: string): CoverageFile => ({
  since: now,
  updated: now,
  lastFlush: now,
  starts: 0,
  files: {},
});

/** Whether a stored value has the shape of a coverage file (a hand edit or an older build must not crash a flush). */
export function asCoverage(value: unknown, now: string): CoverageFile {
  const file = value as Partial<CoverageFile> | null;
  if (!file || typeof file !== 'object' || typeof file.files !== 'object' || !file.files) {
    return emptyCoverage(now);
  }
  return {
    since: typeof file.since === 'string' ? file.since : now,
    updated: typeof file.updated === 'string' ? file.updated : now,
    lastFlush: typeof file.lastFlush === 'string' ? file.lastFlush : now,
    starts: Number.isInteger(file.starts) ? (file.starts as number) : 0,
    files: file.files,
  };
}

/** Merges what a take saw into the file, in place. Returns whether anything about the coverage changed (not the timestamps). */
export function mergeSeen(file: CoverageFile, seen: Seen[], now: string, day: string): boolean {
  let changed = false;
  for (const item of seen) {
    const versions = (file.files[item.path] ||= []);
    const entry = versions.find((candidate) => candidate.sha === item.sha);
    if (!entry) {
      versions.push({
        sha: item.sha,
        mode: item.mode,
        lines: item.lines,
        uncovered: toBase64(item.uncovered),
        firstSeen: now,
        lastSeen: now,
        takes: 1,
        dayUncovered: { [day]: countBits(item.uncovered) },
      });
      versions.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
      versions.splice(MAX_VERSIONS);
      changed = true;
      continue;
    }
    const before = entry.uncovered;
    const merged = andBits(fromBase64(entry.uncovered), item.uncovered);
    entry.uncovered = toBase64(merged);
    if (item.mode === 'function') {
      entry.mode = 'function';
    }
    entry.lastSeen = now;
    entry.takes += 1;
    entry.dayUncovered[day] = countBits(merged);
    if (entry.uncovered !== before) {
      changed = true;
    }
  }
  return changed;
}
