/**
 * What Claude Code's status line knows and the registry doesn't: each session's context use and the account's usage
 * limits. A status line script copies them, on every render, into `<home>/statusline/<session id>.json`:
 *
 *   {session_id, at (seconds), context (% used), rate_limits: {five_hour: {used_percentage, resets_at (seconds)},
 *    seven_day: {...}}}
 *
 * (Claude Code gives the script these as `context_window.used_percentage` and `rate_limits` on stdin; the README's
 * "Board status line" has the lines to add.) The board reads the live sessions' files: each one's context goes on its
 * session, and the usage is the freshest file's. Reading changes nothing: a file whose session is gone is removed once it is a
 * day old by `sweepStatusLines`, which `once-upon agent start` and `agent sweep` run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BoardUsage } from '@once-upon-a-diff/contracts/types';
import { removeFile } from '../stores/fs/files.ts';

/** Usage older than this is not shown: no session has rendered its status line since. */
const USAGE_FRESH_MS = 6 * 3600 * 1000;
/** A gone session's file is removed after this (by the sweep, never by a read). */
const GONE_MS = 24 * 3600 * 1000;

const SESSION_FILE = /^([A-Za-z0-9-]+)\.json$/;

const percent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(100, Math.round(value))
    : null;

/** A limit as the status line gave it: {used_percentage, resets_at (seconds)}, or null. */
function limitOf(value: unknown): { percent: number; resets_at: string | null } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { used_percentage: used, resets_at: resets } = value as Record<string, unknown>;
  const shown = percent(used);
  if (shown === null) {
    return null;
  }
  return {
    percent: shown,
    resets_at:
      typeof resets === 'number' && Number.isFinite(resets)
        ? new Date(resets * 1000).toISOString()
        : null,
  };
}

/** The live sessions' context use by session id, and the freshest usage limits (null when none is fresh). */
export function readStatusLines(
  home: string,
  live: Set<string>,
  nowMs: number,
): { context: Map<string, number>; usage: BoardUsage | null } {
  const dir = path.join(home, 'statusline');
  const context = new Map<string, number>();
  let usage: BoardUsage | null = null;
  let usageAt = -Infinity;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { context, usage };
  }
  for (const name of names) {
    const match = SESSION_FILE.exec(name);
    if (!match) {
      continue;
    }
    const file = path.join(dir, name);
    if (!live.has(match[1])) {
      continue;
    }
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      line = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const used = percent(line.context);
    if (used !== null) {
      context.set(match[1], used);
    }
    const lineAt = typeof line.at === 'number' && Number.isFinite(line.at) ? line.at * 1000 : NaN;
    const limits = (line.rate_limits || {}) as Record<string, unknown>;
    const fiveHour = limitOf(limits.five_hour);
    const sevenDay = limitOf(limits.seven_day);
    if ((fiveHour || sevenDay) && lineAt > usageAt && nowMs - lineAt < USAGE_FRESH_MS) {
      usageAt = lineAt;
      usage = {
        five_hour: fiveHour,
        seven_day: sevenDay,
        at: new Date(lineAt).toISOString(),
      };
    }
  }
  return { context, usage };
}

/**
 * Removes the status line files of sessions that are gone and a day old: the sweep that used to ride on the board's read.
 * `live` is asked only when some file is that old, so the usual run never looks at the sessions. Returns the removed names.
 */
export async function sweepStatusLines(
  home: string,
  live: () => Promise<Set<string>>,
  nowMs: number,
): Promise<string[]> {
  const dir = path.join(home, 'statusline');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const old: { name: string; session: string; file: string }[] = [];
  for (const name of names) {
    const match = SESSION_FILE.exec(name);
    const file = path.join(dir, name);
    try {
      if (match && nowMs - statSync(file).mtimeMs > GONE_MS) {
        old.push({ name, session: match[1], file });
      }
    } catch {
      /* gone already */
    }
  }
  if (!old.length) {
    return [];
  }
  const alive = await live();
  const removed: string[] = [];
  for (const one of old) {
    if (!alive.has(one.session)) {
      removeFile(one.file);
      removed.push(one.name);
    }
  }
  return removed;
}
