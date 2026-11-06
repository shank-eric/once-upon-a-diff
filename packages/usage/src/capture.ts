/*
 * The capture: orchestrates what the entry shim started (instrumentation/usage-probe.ts). It reduces V8's coverage of this
 * checkout's own files to uncovered-line bitsets, merges them into <home>/usage/coverage-bridge.json (the bridge) or
 * coverage-cli.json (a CLI run), and flushes: every 5 minutes, at the end of the process, and on SIGTERM/SIGINT, which a
 * deploy sends. A report reads the last flush: the CLI never signals or calls the bridge.
 *
 * A deploy switches the checkout to the new code BEFORE it stops the old bridge, so the files on disk are already the new
 * version when the old bridge's last flush runs. So the first time a script shows up, its text and sha are snapshotted
 * (the first take is 3 s after start, before any deploy), every later take is mapped with the snapshot, and a script first
 * seen in a file that changed after this process started is skipped, never mapped onto text it did not run.
 */
import path from 'node:path';
import { onSignal } from '@once-upon-a-diff/adapters/os';
import { readUsageJson, writeUsageJson, withUsageLock } from './adapters/usage-file.ts';
import { CHECKOUT, UNMEASURED, readMode, type ScriptCoverage } from './adapters/session.ts';
import { isDetailed, isRunning, restart, startedAtMs, stop, take } from './adapters/session.ts';
import { homeDir } from '@once-upon-a-diff/foundation/settings';
import { createSnapshots } from './snapshots.ts';
import { etDay } from './days.ts';
import { uncoveredLines } from './lines.ts';
import { asCoverage, mergeSeen, type Seen } from './merge.ts';

export type Source = 'bridge' | 'cli';
const FLUSH_MS = 5 * 60 * 1000;
const FIRST_FLUSH_MS = 3000;
const EXIT_CAP_MS = 2000;

export const coverageFileOf = (source: Source) => `coverage-${source}.json`;

const flushHooks = new Set<(stamp: boolean) => void>();
/** Something else to write when the capture flushes (the bridge's action counts). Returns a way to take it back. */
export function onUsageFlush(hook: (stamp: boolean) => void): () => void {
  flushHooks.add(hook);
  return () => flushHooks.delete(hook);
}

export interface Capture {
  /** Takes what ran since the last take and merges it. `stamp` writes the file even when nothing changed. */
  flush(stamp?: boolean): void;
  /** The bridge's port is bound: only now does it count as a start. */
  advertise(): void;
}

let installed: Capture | null = null;

/** Called when the bridge's server listens (a `serve` that lost the port never gets here). */
export function bridgeListening(): void {
  installed?.advertise();
}

/** The relative path of a script's file URL in the checkout, or null for a file the capture does not measure. */
function measuredPath(url: string): string | null {
  if (!url.startsWith('file://')) {
    return null;
  }
  const file = new URL(url).pathname;
  const relative = path.relative(CHECKOUT, decodeURIComponent(file));
  if (
    relative.startsWith('..') ||
    relative.includes('node_modules') ||
    UNMEASURED.includes(relative)
  ) {
    return null;
  }
  return relative;
}

/**
 * Installs the flush timers and handlers for this process, after bin/ started counting. Returns null when counting is
 * not on in this process (off, `usage ...`, a linked worktree).
 */
export function installUsage(argv: string[]): Capture | null {
  if (installed) {
    return installed;
  }
  if (!isRunning()) {
    return null;
  }
  const home = homeDir();
  const source: Source = argv.find((word) => !word.startsWith('-')) === 'serve' ? 'bridge' : 'cli';
  const snapshots = createSnapshots(CHECKOUT, startedAtMs());
  let counted = false;
  let listening = false;
  let finished = false;

  function seenOf(scripts: ScriptCoverage[]): Seen[] {
    const mode = isDetailed() ? 'lines' : 'function';
    const out: Seen[] = [];
    for (const script of scripts) {
      const relative = measuredPath(script.url);
      const snap = relative ? snapshots.of(relative) : null;
      if (relative && snap) {
        out.push({
          path: relative,
          sha: snap.sha,
          mode,
          lines: snap.lines,
          uncovered: uncoveredLines(snap.text, script.functions),
        });
      }
    }
    return out;
  }

  function flush(stamp = false): void {
    // a bridge that has not bound its port takes nothing yet: what ran stays in V8's counters until the first flush after
    // it listens, so its startup code is not discarded
    if (source === 'bridge' && !listening) {
      return;
    }
    try {
      const mode = readMode(home);
      if (mode === 'off') {
        stop();
        return;
      }
      if (isRunning() && (mode === 'lines') !== isDetailed()) {
        // the mode changed: what ran under the old one is taken first, then counting restarts in the new one
        mergeInto(seenOf(take()), stamp);
        restart(mode === 'lines');
        return;
      }
      if (!isRunning()) {
        restart(mode === 'lines'); // was off, now on
        return;
      }
      mergeInto(seenOf(take()), stamp);
    } catch {
      /* the capture never breaks the tool */
    }
  }

  function mergeInto(seen: Seen[], stamp: boolean): void {
    const name = coverageFileOf(source);
    // read-merge-write under a lock, or two runs at once drop each other's lines
    withUsageLock(home, name, () => {
      const now = new Date();
      const when = now.toISOString();
      const file = asCoverage(readUsageJson(home, name), when);
      let changed = mergeSeen(file, seen, when, etDay(now));
      if (source === 'bridge' && !counted && seen.length > 0) {
        counted = true;
        file.starts += 1;
        changed = true;
      }
      // a CLI run writes only when it learned something; the bridge always writes, so its lastFlush is a real answer
      if (changed || stamp || source === 'bridge') {
        file.updated = changed ? when : file.updated;
        file.lastFlush = when;
        writeUsageJson(home, name, file);
      }
    });
  }

  const runHooks = (stamp: boolean) => {
    for (const hook of flushHooks) {
      try {
        hook(stamp);
      } catch {
        /* one hook failing does not stop the rest */
      }
    }
  };

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    flush();
    runHooks(false);
  };

  process.on('exit', finish);
  if (source === 'bridge') {
    const timer = setInterval(() => {
      flush();
      runHooks(false);
    }, FLUSH_MS);
    timer.unref();
    setTimeout(() => flush(), FIRST_FLUSH_MS).unref();
    // Listening for these takes Node's default (end the process) away, so each ends the process itself, whatever happens.
    let signalled = false;
    const end = () => {
      if (signalled) {
        process.exit(143);
      }
      signalled = true;
      setTimeout(() => process.exit(143), EXIT_CAP_MS).unref();
      try {
        finish();
      } finally {
        process.exit(143);
      }
    };
    onSignal('SIGTERM', end);
    onSignal('SIGINT', end);
  }
  installed = {
    flush,
    advertise() {
      if (source === 'bridge' && !listening) {
        listening = true;
      }
    },
  };
  return installed;
}
