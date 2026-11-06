/*
 * What a script's text was when this process first ran it. A deploy switches the checkout to the new code BEFORE it stops
 * the old bridge, so by the time the old bridge's last flush reads a file from disk, it may be the new version. The first
 * time a script shows up its text and sha are kept here, and every later take of that script is mapped with the kept copy.
 * A script first seen in a file that was edited after this process started is skipped (null): it is not the text it ran.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { lineCount, shaOf } from './lines.ts';

export interface Snapshot {
  sha: string;
  text: string;
  lines: number;
}

export function createSnapshots(root: string, startedAtMs: number) {
  const seen = new Map<string, Snapshot | null>();
  return {
    /** The kept copy of a file (relative to the checkout), taking it now the first time; null when it cannot be trusted. */
    of(relative: string): Snapshot | null {
      if (seen.has(relative)) {
        return seen.get(relative) ?? null;
      }
      let snapshot: Snapshot | null = null;
      try {
        const file = path.join(root, relative);
        if (statSync(file).mtimeMs <= startedAtMs) {
          const text = readFileSync(file, 'utf8');
          snapshot = { sha: shaOf(text), text, lines: lineCount(text) };
        }
      } catch {
        snapshot = null;
      }
      seen.set(relative, snapshot);
      return snapshot;
    },
  };
}
