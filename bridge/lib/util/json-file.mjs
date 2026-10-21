/*
 * JSON files in the bridge's home and story folders: read with a fallback,
 * written pretty-printed.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The parsed file, or the fallback when it's missing or isn't JSON. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes the value as 2-space indented JSON. */
export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Writes the value through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeJson(temp, value);
  renameSync(temp, file);
}
