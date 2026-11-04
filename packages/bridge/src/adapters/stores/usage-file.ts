/*
 * <home>/usage/: what the usage capture keeps (coverage, action counts, the CLI's command log, the settings and the last
 * report's snapshot). The folder is the user's alone (0700) and every file 0600. Reads of a missing or unreadable file
 * give the fallback, so a damaged file never stops the tool.
 */
import { mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appendText, ensureDir, ownerOnly, removeDir, removeFile } from './files.ts';
import { readJson, writeJsonAtomic } from './json-file.ts';

export const usageDir = (home: string) => path.join(home, 'usage');
const fileOf = (home: string, name: string) => path.join(usageDir(home), name);

/** The stored JSON file, or the fallback. */
export function readUsageJson<T>(home: string, name: string, fallback: T | null = null): T | null {
  return readJson<T>(fileOf(home, name), fallback);
}

/** Writes a stored JSON file atomically, making the folder (0700) when it is not there. */
export function writeUsageJson(home: string, name: string, value: unknown): void {
  ownerOnly(home);
  ensureDir(usageDir(home), 0o700);
  writeJsonAtomic(fileOf(home, name), value, 0o600);
}

/** A stored text file's text, or '' when it is not there. */
export function readUsageText(home: string, name: string): string {
  try {
    return readFileSync(fileOf(home, name), 'utf8');
  } catch {
    return '';
  }
}

/** A stored file's size in bytes, or 0. */
export function usageFileSize(home: string, name: string): number {
  try {
    return statSync(fileOf(home, name)).size;
  } catch {
    return 0;
  }
}

/** Appends one line to a stored log, unless it is already `cap` bytes. One small append is atomic, so runs at the same moment do not tear each other's lines. */
export function appendUsageLine(home: string, name: string, line: string, cap: number): void {
  if (usageFileSize(home, name) >= cap) {
    return;
  }
  ownerOnly(home);
  ensureDir(usageDir(home), 0o700);
  appendText(fileOf(home, name), `${line}\n`, 0o600);
}

const SETTINGS = 'settings.json';
const PID_FILE = 'bridge-pid.json';

/**
 * The count of times `usage clear` has run. A running bridge keeps action counts in memory, so it compares this with the
 * number it started with before it writes: when it moved, what it holds was cleared and is dropped, not written back.
 */
export function clearEpoch(home: string): number {
  const epoch = readUsageJson<{ epoch?: unknown }>(home, SETTINGS)?.epoch;
  return typeof epoch === 'number' ? epoch : 0;
}

/**
 * Removes what the capture counted. It keeps the settings (clearing data is not choosing on or off, and a missing file
 * reads as on) with the clear epoch moved up, and a live bridge's pid file (reports flush it by that, it is not data).
 */
export function clearUsage(home: string): void {
  const settings = readUsageJson<Record<string, unknown>>(home, SETTINGS) ?? {};
  const epoch = clearEpoch(home) + 1;
  const pid = readUsageJson(home, PID_FILE);
  removeDir(usageDir(home));
  writeUsageJson(home, SETTINGS, { ...settings, epoch });
  if (pid) {
    writeUsageJson(home, PID_FILE, pid);
  }
}

const LOCK_WAIT_MS = 1500;
const LOCK_STALE_MS = 5000;

/**
 * Runs `work` while this process holds `<name>.lock` (a folder, which only one process can make). Read-merge-write on a file
 * several processes share needs it, or the later writer drops what the earlier one added. A lock older than a few seconds
 * is a crashed holder's and is taken over; after a wait the work runs anyway, because the tool must never hang on this.
 */
export function withUsageLock<T>(home: string, name: string, work: () => T): T {
  ownerOnly(home);
  ensureDir(usageDir(home), 0o700);
  const lock = `${fileOf(home, name)}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue; // the holder let go between the two calls
      }
      if (Date.now() > until) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return work();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {
        /* taken over as stale */
      }
    }
  }
}

/** Removes one stored file. */
export function clearUsageFile(home: string, name: string): void {
  removeFile(fileOf(home, name));
}
