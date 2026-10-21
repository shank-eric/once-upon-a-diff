/**
 * Which GitHub repo a story, a checkout or a listener is about, and where the
 * bridge has seen a checkout of each repo. Listeners are scoped per repo
 * (`diff-story wait --repo owner/name`), and the "Copy prompt for Claude"
 * prompt says which checkout to work from.
 *
 *   <home>/checkouts.json   {"owner/name": "/path/to/checkout"}, lowercased keys
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings } from './settings.mjs';

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const sameRepo = (first, second) =>
  !!first && !!second && String(first).toLowerCase() === String(second).toLowerCase();

/** owner/name from a GitHub remote URL (https or ssh), else null. */
export function repoOfRemote(url) {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    String(url || '').trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

const byDir = new Map();
/** The GitHub repo a checkout's origin points at, or null. Cached per process. */
export function repoOfCheckout(dir) {
  if (!dir) {
    return null;
  }
  if (byDir.has(dir)) {
    return byDir.get(dir);
  }
  let repo = null;
  try {
    repo = repoOfRemote(
      execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    repo = null;
  }
  byDir.set(dir, repo);
  return repo;
}

/** A story's repo: a PR story's own, or a local story's checkout's origin. */
export function storyRepo(meta) {
  if (!meta) {
    return null;
  }
  if (meta.kind === 'local') {
    return meta.repo || repoOfCheckout(meta.repo_path);
  }
  return meta.repo || null;
}

const file = (home) => path.join(home, 'checkouts.json');
const readAll = (home) => {
  try {
    return JSON.parse(readFileSync(file(home), 'utf8')) || {};
  } catch {
    return {};
  }
};
/** {repo: checkout} the bridge has seen. */
export const readCheckouts = (home) => readAll(home);

/** Note where a repo's checkout is (from a local story, or a listener's working folder). */
export function seenCheckout(home, repo, dir) {
  if (!repo || !dir || !REPO_RE.test(repo)) {
    return;
  }
  const all = readAll(home);
  const key = repo.toLowerCase();
  if (all[key] === dir) {
    return;
  }
  all[key] = dir;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(file(home), JSON.stringify(all, null, 2));
  } catch {
    /* a convenience */
  }
}

/**
 * Where to work on a repo: the checkout the bridge has seen, else <dir>/<name> for each of config.json's
 * checkout_dirs (default ~/Development) when its origin is that repo, else null. DIFF_STORY_DEV_DIR overrides them.
 */
export function checkoutFor(home, repo, { dev } = {}) {
  if (!repo) {
    return null;
  }
  const seen = readAll(home)[repo.toLowerCase()];
  if (seen && existsSync(seen)) {
    return seen;
  }
  const name = repo.split('/')[1];
  const dirs = dev ? [dev] : readSettings(home).checkoutDirs;
  for (const dir of dirs.map((base) => path.join(base, name))) {
    if (existsSync(dir) && sameRepo(repoOfCheckout(dir), repo)) {
      return dir;
    }
  }
  return null;
}

/** ~ for the home folder, so the prompt reads well. */
export const tilde = (dir) =>
  dir && dir.startsWith(os.homedir() + path.sep) ? `~${dir.slice(os.homedir().length)}` : dir;
