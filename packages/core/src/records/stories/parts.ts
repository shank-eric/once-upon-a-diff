/*
 * A story's parts: the repo's parts file (domain/src/parts.ts), found and read, and what the story's chapters touch
 * of it. Worked out when the story is loaded, never stored: nothing on disk changes, an older story gains its strip the day
 * its repo gets a file, and a renamed part is renamed everywhere.
 *
 * Where the file is, first found wins:
 *   <home>/parts/<owner>-<name>.json    the reviewer's own (the one for a repo that is not theirs to commit to)
 *   <checkout>/.once-upon-parts.json    the repo's: a local story's worktree, a PR story's main checkout (its working tree, not the PR's head)
 * No file, or one that doesn't check out (parsePartsFile), shows no strip, and is never an error. A reviewer's own file that
 * is too big (over MAX_PARTS_BYTES) or doesn't check out is ignored with a warning on stderr, and the repo's file is used instead.
 * Files are cached by path and mtime: an edit is picked up on the next fetch, with no restart, and a bad file warns once.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { readJson } from '../../adapters/stores/fs/json-file.ts';
import {
  parsePartsFile,
  storyPartsOf,
  type PartsFile,
  type StoryParts,
} from '@once-upon-a-diff/domain/parts';
import { storyRepo } from './meta.ts';
import { checkoutFor } from '../../foundation/repos.ts';
import type { StoryMeta } from './types.ts';

/** The in-repo file's name, at a checkout's root. */
export const PARTS_FILE = '.once-upon-parts.json';

/** The reviewer's own file for a repo: `<home>/parts/<owner>-<name>.json`, the repo lowercased. */
export const userPartsFile = (home: string, repo: string): string =>
  path.join(home, 'parts', `${repo.toLowerCase().replace(/\//g, '-')}.json`);

/** The biggest parts file read: a real one is a few KB. */
export const MAX_PARTS_BYTES = 256 * 1024;

const defaultWarn = (line: string): void => {
  process.stderr.write(`once-upon bridge: ${line}\n`);
};

const cache = new Map<string, { mtimeMs: number; size: number; file: PartsFile | null }>();

/** One parts file at `file`, read and checked (cached by mtime), or null when it is missing, too big or doesn't check out. */
function readParts(file: string, warn: (line: string) => void): PartsFile | null {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.file;
  }
  let parsed: PartsFile | null = null;
  if (stat.size > MAX_PARTS_BYTES) {
    warn(`ignoring parts file ${file}: over ${MAX_PARTS_BYTES / 1024} KB`);
  } else {
    parsed = parsePartsFile(readJson(file), (why) => warn(`parts file ${file}: ${why}`));
    if (!parsed) {
      warn(`ignoring parts file ${file}: it is not a valid version 1 parts file`);
    }
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, file: parsed });
  return parsed;
}

/** The story's repo's parts file, read and checked, or null. An invalid personal file falls back to the repo's (and warns). */
export function partsFileOf(
  home: string,
  meta: StoryMeta,
  warn: (line: string) => void = defaultWarn,
): PartsFile | null {
  const repo = storyRepo(meta);
  const user = repo ? readParts(userPartsFile(home, repo), warn) : null;
  if (user) {
    return user;
  }
  const checkout = meta.kind === 'local' ? meta.repo_path : checkoutFor(home, repo);
  return checkout ? readParts(path.join(checkout, PARTS_FILE), warn) : null;
}

/**
 * What the story draws, or undefined when its repo has no (valid) parts file. Call it last: `chapterRels` and `allRels` must be
 * the story's final ones (after a local diff has dropped the files that left it, and the "Not in a chapter yet" chapter is added).
 */
export function storyParts(
  home: string,
  meta: StoryMeta,
  chapterRels: string[][],
  allRels: string[],
): StoryParts | undefined {
  const file = partsFileOf(home, meta);
  return file ? storyPartsOf(file, chapterRels, allRels) : undefined;
}
