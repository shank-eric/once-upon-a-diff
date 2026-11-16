/*
 * File writes that are not JSON documents: folders, appended log lines, copies, removals and permissions. Anything in the
 * bridge that changes a file or folder goes through here or through json-file.ts, so a lint rule can keep the
 * services and the apps from reaching for `node:fs` writes themselves (configs/eslint.side-effects.mjs).
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

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

/** A file's size in bytes, 0 when it is not there. */
export function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Empties a file in place: the same inode, so a process that holds it open for appending carries on at the new end. */
export function truncateFile(file: string): void {
  truncateSync(file, 0);
}

/** Removes a folder and everything in it, with no error when it is not there. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Moves a folder to a path that is not there yet (the caller checks). On one filesystem that is a rename. Across filesystems
 * (EXDEV) the folder is copied to `<dest's parent>/.<name>.moving` (symbolic links copied as links, never followed), renamed
 * into place, and only then removed from `src`, so a reader never sees half a folder at `dest`.
 */
export function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
  }
  const staged = path.join(path.dirname(dest), `.${path.basename(dest)}.moving`);
  rmSync(staged, { recursive: true, force: true });
  cpSync(src, staged, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  renameSync(staged, dest);
  rmSync(src, { recursive: true, force: true });
}
