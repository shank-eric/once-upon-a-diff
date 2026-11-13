/*
 * How long each story command took, for telling where a story build's time goes: one JSON line per run in
 * `<dir>/timings.jsonl`, {at, command, ms, ...what that command adds (hunks, chapters, fails...)}. The usage capture
 * (usage/src/cli-log.ts) is off in a linked worktree, where authors tell their own stories, and has no duration, so
 * this lives with the story's scratch folder instead. A convenience: it never throws.
 */
import path from 'node:path';
import { appendText } from '@once-upon-a-diff/adapters/stores/fs/files';

export type TimingExtra = Record<string, string | number | boolean | null | undefined>;

/** Adds one line to `<dir>/timings.jsonl`. Nothing happens, and nothing is thrown, when the folder can't be written. */
export function noteTiming(
  dir: string,
  entry: { command: string; ms: number } & TimingExtra,
  now: Date = new Date(),
): void {
  try {
    const { command, ms, ...extra } = entry;
    const line = { at: now.toISOString(), command, ms: Math.round(ms), ...extra };
    appendText(path.join(dir, 'timings.jsonl'), `${JSON.stringify(line)}\n`);
  } catch {
    /* the timing is a convenience, never a reason for a command to fail */
  }
}
