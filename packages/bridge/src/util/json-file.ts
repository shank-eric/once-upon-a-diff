/*
 * JSON files in the bridge's home and story folders: read with a fallback,
 * written pretty-printed.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The parsed file, or the fallback when it's missing or isn't JSON. */
export function readJson<T = unknown>(file: string, fallback: T | null = null): T | null {
  try {
    // the file's shape is the caller's to check: the bridge wrote it, or a person may have edited it
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Writes the value as 2-space indented JSON. */
export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Writes the value through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeJson(temp, value);
  renameSync(temp, file);
}
