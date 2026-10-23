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
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkoutFor } from '../config/repos.ts';
import { ownerOnly } from '../config/settings.ts';
import { readJson, writeJson } from '../util/json-file.ts';

export const STORY_FOLDER = '.once-upon';
const EXCLUDE_LINE = `/${STORY_FOLDER}/`;
const git = (dir: string, args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

/** The main checkout of the repo dir is in (for a worktree, the checkout its .git belongs to), or dir itself. */
export function mainCheckout(dir: string): string {
  try {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
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
    common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
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
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${text && !text.endsWith('\n') ? '\n' : ''}# Once Upon a Diff's stories (local only)\n${EXCLUDE_LINE}\n`,
  );
  return true;
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
  mkdirSync(home, { recursive: true });
  writeJson(indexFile(home), all);
}

/** The folder a new story goes in: <checkout>/.once-upon/<id>, made and excluded, or <home>/<id>. */
export function storyDirFor(
  home: string,
  id: string,
  { checkout = null, repo = null }: { checkout?: string | null; repo?: string | null } = {},
): string {
  const top =
    checkout ||
    (repo ? checkoutFor(home, repo) && mainCheckout(checkoutFor(home, repo) as string) : null);
  if (top && existsSync(top) && excludeStories(top)) {
    ownerOnly(path.join(top, STORY_FOLDER)); // PR text and draft comments: the user's alone, whatever the checkout's mode
    const dir = path.join(top, STORY_FOLDER, id);
    mkdirSync(dir, { recursive: true });
    indexStory(home, id, dir);
    return dir;
  }
  const dir = path.join(home, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
