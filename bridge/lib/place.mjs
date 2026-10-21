/**
 * Where stories live: in a hidden .diff-story/ folder inside the repo's own
 * checkout, kept out of git by that repo's .git/info/exclude (local-only and
 * never committed, so no .gitignore change and `git status` stays clean).
 *
 *   <worktree>/.diff-story/<id>/         a local story, in the checkout or worktree it diffs
 *   <main checkout>/.diff-story/<id>/    a PR story, in the repo's main checkout (worktrees come and go)
 *   ~/.diff-story/<id>/                  a story whose repo has no known checkout, as before
 *   ~/.diff-story/stories.json           the index: {id: folder}
 *
 * Everything bridge-wide stays in ~/.diff-story: config, prefs, the inbox,
 * builds, and each story's state (viewed files, notes, the panel's step).
 *
 * pr-story's render still publishes to ~/.diff-story/<id>/. The bridge adopts
 * a story there (moves its files into the checkout) once it knows where the
 * repo's checkout is, from local stories, `wait --repo` run in a checkout,
 * checkouts.json, or ~/Development/<name> with that origin.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkoutFor } from './repos.mjs';

export const STORY_FOLDER = '.diff-story';
const EXCLUDE_LINE = `/${STORY_FOLDER}/`;
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The main checkout of the repo dir is in (for a worktree, the checkout its .git belongs to), or dir itself. */
export function mainCheckout(dir) {
  try {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (path.basename(common) === '.git') return path.dirname(common);
  } catch { /* not a checkout */ }
  return dir;
}

/** Keep .diff-story/ out of git for this checkout and all its worktrees: one line in the common .git/info/exclude. */
export function excludeStories(dir) {
  let common;
  try { common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']); } catch { return false; }
  const file = path.join(common, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  if (text.split('\n').some(l => l.trim() === EXCLUDE_LINE || l.trim() === `${STORY_FOLDER}/` || l.trim() === STORY_FOLDER)) return true;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Diff Story Mode's stories (local only)\n${EXCLUDE_LINE}\n`);
  return true;
}

// ---------- the index
const indexFile = home => path.join(home, 'stories.json');
export function readIndex(home) {
  try { return JSON.parse(readFileSync(indexFile(home), 'utf8')) || {}; } catch { return {}; }
}
export function indexStory(home, id, dir) {
  const all = readIndex(home);
  if (all[id] === dir) return;
  all[id] = dir;
  mkdirSync(home, { recursive: true });
  writeFileSync(indexFile(home), JSON.stringify(all, null, 2));
}

/** The folder a new story goes in: <checkout>/.diff-story/<id>, made and excluded, or <home>/<id>. */
export function storyDirFor(home, id, { checkout = null, repo = null } = {}) {
  const top = checkout || (repo ? checkoutFor(home, repo) && mainCheckout(checkoutFor(home, repo)) : null);
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

/** Move a story folder's files into another folder (newer files win: what's moving is the latest render), then remove the empty one. */
export function moveStory(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (statSync(src).isDirectory() && existsSync(dest)) { moveStory(src, dest); continue; }
    renameSync(src, dest);
  }
  rmdirSync(from);
}

const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Where a story in <home> belongs, or null to leave it there. */
function homeFor(home, dir) {
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  if (meta.kind === 'local') return meta.repo_path && existsSync(meta.repo_path) ? meta.repo_path : null; // the worktree it diffs
  let repo = meta.repo;
  if (!repo) {
    const pr = readJson(path.join(dir, 'pr.json'));
    if (pr && pr.url) repo = pr.url.split('/').slice(3, 5).join('/');
  }
  const co = repo ? checkoutFor(home, repo) : null;
  return co ? mainCheckout(co) : null;
}

let lastAdopt = 0;
/**
 * Move stories sitting in <home> into their repo's checkout, when it's known. Cheap to call often
 * (at most every 2s). Returns [{id, from, to}].
 */
export function adoptHomeStories(home, { isStoryDir, force = false } = {}) {
  if (!force && Date.now() - lastAdopt < 2000) return [];
  lastAdopt = Date.now();
  const moved = [];
  let entries = [];
  try { entries = readdirSync(home, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return moved; }
  for (const d of entries) {
    const from = path.join(home, d.name);
    if (!isStoryDir(from)) continue;
    const top = homeFor(home, from);
    if (!top || !excludeStories(top)) continue;
    const to = path.join(top, STORY_FOLDER, d.name);
    try {
      moveStory(from, to);
      indexStory(home, d.name, to);
      moved.push({ id: d.name, from, to });
    } catch { /* leave it readable where it is */ }
  }
  return moved;
}
