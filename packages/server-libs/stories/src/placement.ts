/**
 * Where stories live: in a hidden .once-upon/ folder inside the repo's own
 * checkout, kept out of git by that repo's .git/info/exclude (local-only and
 * never committed, so no .gitignore change and `git status` stays clean).
 *
 *   <worktree>/.once-upon/<id>/           a local story, in the checkout or worktree it diffs
 *   <main checkout>/.once-upon/<id>/      a PR story, in the repo's main checkout (worktrees come and go)
 *   ~/.once-upon/<id>/                    a story whose repo has no known checkout, as before
 *   ~/.once-upon/stories.json             the index: {id: folder}
 *
 * Everything bridge-wide stays in ~/.once-upon: config, prefs, the inbox,
 * builds, and each story's state (viewed files, notes, the panel's step).
 *
 * Every story gets there one way: `once-upon publish` (which once-upon's
 * build runs) or `once-upon local`, through storyDirFor. The checkout is the
 * one the bridge knows for the repo, from local stories, `wait --repo` run in
 * a checkout, checkouts.json, or ~/Development/<name> with that origin.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { checkoutFor } from '@once-upon-a-diff/foundation/repos';
import { homeDir } from '@once-upon-a-diff/foundation/settings';
import { ownerOnly, ensureDir, appendText } from '@once-upon-a-diff/adapters/stores/fs/files';
import { readJson, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { readStoryKinds } from '@once-upon-a-diff/contracts/files/story-kinds';
import { runGit } from '@once-upon-a-diff/adapters/git';

export const STORY_FOLDER = '.once-upon';
const EXCLUDE_LINE = `/${STORY_FOLDER}/`;

/** The main checkout of the repo dir is in (for a worktree, the checkout its .git belongs to), or dir itself. */
export function mainCheckout(dir: string): string {
  try {
    const common = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      quiet: true,
    }).trim();
    if (path.basename(common) === '.git') {
      return path.dirname(common);
    }
  } catch {
    /* not a checkout */
  }
  return dir;
}

/** Keep .once-upon/ out of git for this checkout and all its worktrees: one line in the common .git/info/exclude. */
export function excludeStories(dir: string): boolean {
  let common;
  try {
    common = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      quiet: true,
    }).trim();
  } catch {
    return false;
  }
  const file = path.join(common, 'info', 'exclude');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  if (
    text
      .split('\n')
      .some(
        (line) =>
          line.trim() === EXCLUDE_LINE ||
          line.trim() === `${STORY_FOLDER}/` ||
          line.trim() === STORY_FOLDER,
      )
  ) {
    return true;
  }
  ensureDir(path.dirname(file));
  appendText(
    file,
    `${text && !text.endsWith('\n') ? '\n' : ''}# Once Upon a Diff's stories (local only)\n${EXCLUDE_LINE}\n`,
  );
  return true;
}

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
const indexFile = (home: string) => path.join(home, 'stories.json');
export function readIndex(home: string): Record<string, string> {
  return readJson<Record<string, string>>(indexFile(home), {}) || {};
}
export function indexStory(home: string, id: string, dir: string): void {
  const all = readIndex(home);
  if (all[id] === dir) {
    return;
  }
  all[id] = dir;
  ensureDir(home);
  writeJsonAtomic(indexFile(home), all);
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

/** The folder a new story goes in: <checkout>/.once-upon/<id>, made and excluded, or <home>/<id>. `kind` is recorded for the id. */
export function storyDirFor(
  home: string,
  id: string,
  {
    checkout = null,
    repo = null,
    kind = null,
  }: { checkout?: string | null; repo?: string | null; kind?: 'github' | 'local' | null } = {},
): string {
  if (kind) {
    recordKind(home, id, kind);
  }
  const top =
    checkout ||
    (repo ? checkoutFor(home, repo) && mainCheckout(checkoutFor(home, repo) as string) : null);
  if (top && existsSync(top) && excludeStories(top)) {
    ownerOnly(path.join(top, STORY_FOLDER)); // PR text and draft comments: the user's alone, whatever the checkout's mode
    const dir = path.join(top, STORY_FOLDER, id);
    ensureDir(dir);
    indexStory(home, id, dir);
    return dir;
  }
  const dir = path.join(home, id);
  ensureDir(dir);
  return dir;
}
