/**
 * Moving the stories a checkout holds into the bridge's folder (placement.ts). Before, a story was kept in
 * <checkout>/.once-upon/<id> and recorded in <home>/stories.json; a branch that tracks files there replaces a story when it is
 * checked out, so a story now lives in <home>/<id> and nothing reads a checkout's folder again.
 *
 * The index names every story ever placed in a checkout, so it drives the move and no checkout is scanned. A folder moves only
 * when it is plainly the story it claims to be; any other stays where it is, is not served and is reported (never deleted):
 * it is a symbolic link or holds one, a branch tracks files in it, its meta.json fails the checks of meta.ts, or the home
 * already has a folder for the id. Run by the CLI at the start of every command and by `once-upon setup`, under the index's
 * lock, which storyDirFor takes too. A second run finds nothing outside the home and does nothing.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '@once-upon-a-diff/adapters/git';
import { moveDir, ownerOnly } from '@once-upon-a-diff/adapters/stores/fs/files';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson, withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { STORY_ID_RE } from '@once-upon-a-diff/terms/patterns';
import { checkedMeta } from './meta.ts';
import {
  indexFile,
  inCheckout,
  isStoryId,
  readIndex,
  recordKind,
  recordedKind,
} from './placement.ts';
import type { StoryMeta } from './types.ts';

/** A story folder in a checkout, as the index names it. */
export interface LegacyStory {
  id: string;
  dir: string;
}

/** What a migration did: the ids moved, and the legacy folders left where they are with why. */
export interface Migration {
  moved: string[];
  skipped: (LegacyStory & { why: string })[];
}

/** The index's stories that are folders in a checkout (not under the home) and still there. */
export function legacyStories(home: string): LegacyStory[] {
  const out: LegacyStory[] = [];
  for (const [id, dir] of Object.entries(readIndex(home))) {
    if (typeof dir === 'string' && inCheckout(dir, home) && existsSync(dir)) {
      out.push({ id, dir });
    }
  }
  return out;
}

/** Whether the folder is a link or holds one anywhere inside. */
function holdsLink(dir: string): boolean {
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      return true;
    }
    return readdirSync(dir, { withFileTypes: true }).some((entry) =>
      entry.isSymbolicLink() ? true : entry.isDirectory() && holdsLink(path.join(dir, entry.name)),
    );
  } catch {
    return true;
  }
}

/** Why a legacy folder is not to be moved (and not served), or null when it may. Reads only. */
export function legacyProblem(home: string, { id, dir }: LegacyStory): string | null {
  const holder = path.dirname(path.dirname(dir));
  if (path.basename(dir) !== id || !STORY_ID_RE.test(id) || !isStoryId(id)) {
    return `${id} does not name its folder`;
  }
  if (lstatSync(path.dirname(dir)).isSymbolicLink()) {
    return `${path.dirname(dir)} is a symbolic link`;
  }
  if (holdsLink(dir)) {
    return `${dir} is or holds a symbolic link`;
  }
  // icase: on a case-insensitive filesystem a branch's `.ONCE-UPON/<id>/chapters.json` lands in this folder
  let tracked: string;
  try {
    tracked = runGit(holder, ['ls-files', '-z', '--', `:(icase).once-upon/${id}`], {
      quiet: true,
      timeoutMs: 10000,
    });
  } catch {
    return `git could not list the files ${holder} tracks`;
  }
  if (tracked) {
    return `a branch tracks files in ${dir}`;
  }
  const { meta, problem } = checkedMeta(
    dir,
    readJson<Partial<StoryMeta>>(path.join(dir, 'meta.json'), {}),
    home,
  );
  if (problem) {
    return problem;
  }
  const recorded = recordedKind(home, id);
  if (recorded && recorded !== meta.kind) {
    return `kind ${meta.kind} is not the ${recorded} this story was made as`;
  }
  if (!existsSync(path.join(dir, 'chapters.json'))) {
    return 'it has no chapters.json';
  }
  if (existsSync(path.join(home, id))) {
    return `${path.join(home, id)} is already there`;
  }
  return null;
}

/** Moves one legacy story that passes legacyProblem into <home>/<id> and records it; the caller holds the index's lock. */
function moveOne(home: string, story: LegacyStory): { why: string } | null {
  // looked at again under the lock: a writer or another migration may have moved or made it meanwhile
  const why = legacyProblem(home, story);
  if (why) {
    return { why };
  }
  const meta = readJson<Partial<StoryMeta>>(path.join(story.dir, 'meta.json'), {});
  const dest = path.join(home, story.id);
  try {
    moveDir(story.dir, dest);
  } catch (error) {
    return { why: `could not move it: ${(error as Error).message}` };
  }
  ownerOnly(dest);
  if (meta?.kind === 'github' || meta?.kind === 'local') {
    recordKind(home, story.id, meta.kind);
  }
  updateJson(indexFile(home), {} as Record<string, string>, (all) => {
    delete all[story.id];
  });
  return null;
}

/** Moves every legacy story that passes legacyProblem into <home>/<id>; reports the rest. Does nothing when the index names none. */
export function migrateStories(home: string): Migration {
  const result: Migration = { moved: [], skipped: [] };
  if (legacyStories(home).length === 0) {
    return result; // the common case: one JSON read, no lock, no git
  }
  withLock(indexFile(home), () => {
    for (const story of legacyStories(home)) {
      const failed = moveOne(home, story);
      if (failed) {
        result.skipped.push({ ...story, ...failed });
      } else {
        result.moved.push(story.id);
      }
    }
  });
  return result;
}

/**
 * Moves the one story folder `<checkout>/.once-upon/<id>` into <home>/<id> through the same checks and lock as the migration,
 * whether or not the index names it (a worktree's folder that cleanup is about to remove). Returns null when moved, else why
 * it was left where it is.
 */
export function moveStoryFolder(home: string, dir: string): string | null {
  const target = path.resolve(dir);
  if (!existsSync(target)) {
    return `${target} is not there`;
  }
  if (!inCheckout(target, home)) {
    return `${target} is not a .once-upon/<id> folder in a checkout`;
  }
  const story = { id: path.basename(target), dir: target };
  const result = withLock(indexFile(home), () => moveOne(home, story));
  return result ? result.why : null;
}
