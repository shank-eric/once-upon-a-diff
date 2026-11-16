/**
 * Where stories live: one folder per story id in the bridge's own folder, where no checked-out branch can write.
 *
 *   ~/.once-upon/<id>/                    a story (PR: <Owner>-<repo>-<N>; local: local-<folder>-<branch>)
 *   ~/.once-upon/stories.json             the old index {id: folder}: now only what the migration reads (migrate.ts)
 *
 * Stories used to live in <checkout>/.once-upon/<id>, where a PR branch that tracks files there could replace a story
 * when it was checked out. Those folders are moved here once, by migrate.ts. Everything bridge-wide lives beside them:
 * config, prefs, the inbox, builds, and each story's state (viewed files, notes, the panel's step).
 *
 * Every story gets here one way: `once-upon publish` (which once-upon's build runs) or `once-upon local`, through storyDirFor.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from '@once-upon-a-diff/foundation/settings';
import { ownerOnly, ensureDir } from '@once-upon-a-diff/adapters/stores/fs/files';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson, withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { readStoryKinds } from '@once-upon-a-diff/contracts/files/story-kinds';

const STORY_FOLDER = '.once-upon';

/** What the bridge keeps in its own folder: an id named like one of these would write a story into it. */
const HOME_ENTRIES = new Set([
  'agents.jsonl',
  'asking.json',
  'backlog.jsonl',
  'bridge.json',
  'bridge.log',
  'builds.json',
  'checkouts.json',
  'config.json',
  'cursors',
  'editor',
  'extension-seen.json',
  'finished-agents.json',
  'fixes.json',
  'github-answers.json',
  'handed.json',
  'inbox.jsonl',
  'listener-history.json',
  'listeners',
  'listeners.log',
  'logs',
  'parts',
  'prefs.json',
  'reviews',
  'state',
  'statusline',
  'stories.json',
  'story-kinds.json',
  'usage',
  'worktree-cleanups.jsonl',
  'worktrees.json',
]);

/** Whether an id may name a story folder under the home: not one of the home's own entries (or a lock folder). */
export const isStoryId = (id: string): boolean => !HOME_ENTRIES.has(id) && !id.endsWith('.lock');

/** A path with symlinks resolved, or null when it is not there. */
export const realPathOf = (file: string): string | null => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * Whether a story folder is in a checkout (<checkout>/.once-upon/<id>, where a checked-out branch can replace it) rather
 * than in the bridge's own folder (<home>/<id>, where no branch can write). The home is told apart by its path, never by
 * its name: the default home is ~/.once-upon, which is named like a checkout's story folder.
 */
export function inCheckout(dir: string, home: string = homeDir()): boolean {
  const parent = path.dirname(dir);
  if (path.basename(parent) !== STORY_FOLDER) {
    return false;
  }
  const here = realPathOf(parent);
  const homePath = realPathOf(home);
  return !(here && homePath && here === homePath);
}

// ---------- the index
export const indexFile = (home: string) => path.join(home, 'stories.json');
export function readIndex(home: string): Record<string, string> {
  return readJson<Record<string, string>>(indexFile(home), {}) || {};
}

// ---------- the kinds
// What kind each story was made as, kept in the bridge's own folder: a story folder in a checkout can be overwritten by a branch
// that tracks files there, so its meta.json cannot be the one to say what it is (meta.ts refusalOf).
const kindsFile = (home: string) => path.join(home, 'story-kinds.json');
export const recordedKind = (home: string, id: string): string | null =>
  (readStoryKinds(readJson<unknown>(kindsFile(home), {})) ?? {})[id] ?? null;
/** Written under the file's lock: the bridge and the CLI both record kinds, and two at once must both land. */
export function recordKind(home: string, id: string, kind: string): void {
  if (recordedKind(home, id) === kind) {
    return;
  }
  ensureDir(home);
  updateJson(kindsFile(home), {} as Record<string, unknown>, (all) => {
    all[id] = kind;
  });
}

/**
 * The folder a new story goes in: <home>/<id>, made owner-only. `kind` is recorded for the id. Made under the index's lock,
 * which the migration holds while it moves a folder in, so a writer never lands files in a folder that is being moved.
 */
export function storyDirFor(
  home: string,
  id: string,
  { kind = null }: { kind?: 'github' | 'local' | null } = {},
): string {
  if (!isStoryId(id)) {
    throw new Error(`story id ${id} is a name the bridge's own folder uses: pass another --id`);
  }
  if (kind) {
    recordKind(home, id, kind);
  }
  const dir = path.join(home, id);
  withLock(indexFile(home), () => {
    ensureDir(home);
    ownerOnly(dir);
  });
  return dir;
}
