/*
 * File writes that are not JSON documents: folders, appended log lines, copies, removals and permissions. Anything in the
 * bridge that changes a file or folder goes through here or through json-file.ts, so a lint rule can keep the
 * services and the apps from reaching for `node:fs` writes themselves (configs/eslint.side-effects.mjs).
 */
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Makes the folder (and its parents) if it is missing, the user's alone (0700) unless `mode` says otherwise. The mode applies
 * only to a folder this call makes, so a reader that never calls this changes nothing, and the first write to a home that is
 * not there yet makes it owner-only.
 */
export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
}

/** Makes the folder if it's missing, and makes it the user's alone (0700) even when it was there already. */
export function ownerOnly(dir: string): void {
  ensureDir(dir, 0o700);
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to change: leave it */
  }
}

/** Appends text to a file, making it when it is missing. `mode` applies when the file is made. */
export function appendText(file: string, text: string, mode?: number): void {
  appendFileSync(file, text, mode === undefined ? undefined : { mode });
}

/** Writes a file's whole text in place (not atomically: json-file.ts has the atomic writers). */
export function writeText(file: string, text: string, mode?: number): void {
  writeFileSync(file, text, mode === undefined ? undefined : { mode });
}

/** Removes a file, with no error when it is not there. */
export function removeFile(file: string): void {
  rmSync(file, { force: true });
}

/** Sets a file's permissions. */
export function restrictFile(file: string, mode: number): void {
  chmodSync(file, mode);
}

/** Copies a file. */
export function copyFile(src: string, dest: string): void {
  copyFileSync(src, dest);
}

/** Removes a folder and everything in it, with no error when it is not there. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
