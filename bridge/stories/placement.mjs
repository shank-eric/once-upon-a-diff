/**
 * Where stories live: in a hidden .pr-story/ folder inside the repo's own
 * checkout, kept out of git by that repo's .git/info/exclude (local-only and
 * never committed, so no .gitignore change and `git status` stays clean).
 *
 *   <worktree>/.pr-story/<id>/           a local story, in the checkout or worktree it diffs
 *   <main checkout>/.pr-story/<id>/      a PR story, in the repo's main checkout (worktrees come and go)
 *   ~/.pr-story/<id>/                    a story whose repo has no known checkout, as before
 *   ~/.pr-story/stories.json             the index: {id: folder}
 *
 * Everything bridge-wide stays in ~/.pr-story: config, prefs, the inbox,
 * builds, and each story's state (viewed files, notes, the panel's step).
 *
 * Every story gets there one way: `pr-story publish` (which pr-story's
 * build runs) or `pr-story local`, through storyDirFor. The checkout is the
 * one the bridge knows for the repo, from local stories, `wait --repo` run in
 * a checkout, checkouts.json, or ~/Development/<name> with that origin.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { checkoutFor } from '../config/repos.mjs';
import { readJson, writeJson } from '../util/json-file.mjs';

export const STORY_FOLDER = '.pr-story';
const EXCLUDE_LINE = `/${STORY_FOLDER}/`;
const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

/** The main checkout of the repo dir is in (for a worktree, the checkout its .git belongs to), or dir itself. */
export function mainCheckout(dir) {
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

/** Keep .pr-story/ out of git for this checkout and all its worktrees: one line in the common .git/info/exclude. */
export function excludeStories(dir) {
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
    `${text && !text.endsWith('\n') ? '\n' : ''}# PR Story's stories (local only)\n${EXCLUDE_LINE}\n`,
  );
  return true;
}

// ---------- the index
const indexFile = (home) => path.join(home, 'stories.json');
export function readIndex(home) {
  return readJson(indexFile(home), {}) || {};
}
export function indexStory(home, id, dir) {
  const all = readIndex(home);
  if (all[id] === dir) {
    return;
  }
  all[id] = dir;
  mkdirSync(home, { recursive: true });
  writeJson(indexFile(home), all);
}

/**
 * One-time move from the old name, per checkout: for each index entry under a
 * <checkout>/.diff-story/, rename that folder to .pr-story/ (when there's no
 * .pr-story/ yet), swap the exclude line, and repoint the index. Returns one
 * line per checkout moved. Safe to delete once no checkout has a .diff-story/ left.
 */
export function moveLegacyStoryFolders(home) {
  const all = readIndex(home);
  const lines = [];
  let repointed = false;
  const legacy = `${path.sep}.diff-story${path.sep}`;
  for (const [id, dir] of Object.entries(all)) {
    if (typeof dir !== 'string' || !dir.includes(legacy)) {
      continue;
    }
    const top = dir.slice(0, dir.lastIndexOf(legacy));
    const oldFolder = path.join(top, '.diff-story');
    const newFolder = path.join(top, STORY_FOLDER);
    if (existsSync(oldFolder) && !existsSync(newFolder)) {
      renameSync(oldFolder, newFolder);
      swapLegacyExclude(top);
      excludeStories(top);
      lines.push(`moved ${oldFolder} to ${newFolder} (the project is PR Story now)`);
    }
    const moved = path.join(newFolder, path.basename(dir));
    if (!existsSync(dir) && existsSync(moved)) {
      all[id] = moved;
      repointed = true;
    }
  }
  if (repointed) {
    writeJson(indexFile(home), all);
  }
  return lines;
}

/** In the common .git/info/exclude, turn the old /.diff-story/ line (and its comment) into the new one. */
function swapLegacyExclude(dir) {
  let file;
  try {
    file = path.join(
      git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      'info',
      'exclude',
    );
  } catch {
    return;
  }
  if (!existsSync(file)) {
    return;
  }
  const text = readFileSync(file, 'utf8');
  const next = text
    .replace(/^# Diff Story Mode's stories \(local only\)$/m, "# PR Story's stories (local only)")
    .replace(/^\/?\.diff-story\/?$/m, EXCLUDE_LINE);
  if (next !== text) {
    writeFileSync(file, next);
  }
}

/** The folder a new story goes in: <checkout>/.pr-story/<id>, made and excluded, or <home>/<id>. */
export function storyDirFor(home, id, { checkout = null, repo = null } = {}) {
  const top =
    checkout || (repo ? checkoutFor(home, repo) && mainCheckout(checkoutFor(home, repo)) : null);
  if (top && existsSync(top) && excludeStories(top)) {
    const dir = path.join(top, STORY_FOLDER, id);
    mkdirSync(dir, { recursive: true });
    indexStory(home, id, dir);
    return dir;
  }
  const dir = path.join(home, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
