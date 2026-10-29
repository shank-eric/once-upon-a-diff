/**
 * Which GitHub repo a story, a checkout or a listener is about, and where the
 * bridge has seen a checkout of each repo. Listeners are scoped per repo
 * (`once-upon wait --repo owner/name`), and the listen prompt
 * says which checkout to work from.
 *
 *   <home>/checkouts.json   {"owner/name": "/path/to/checkout"}, lowercased keys
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings } from './settings.ts';
import { runGitAsync } from '../util/git.ts';
import { readJson } from '../util/json-file.ts';
import type { StoryMeta } from '../types.ts';

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const sameRepo = (first: unknown, second: unknown): boolean =>
  !!first && !!second && String(first).toLowerCase() === String(second).toLowerCase();

/** owner/name from a GitHub remote URL (https or ssh), else null. */
export function repoOfRemote(url: string | null | undefined): string | null {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    String(url || '').trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

const byDir = new Map<string, string | null>();
/** The GitHub repo a checkout's origin points at, or null. Cached per process. */
export function repoOfCheckout(dir: string | null | undefined): string | null {
  if (!dir) {
    return null;
  }
  if (byDir.has(dir)) {
    return byDir.get(dir) as string | null;
  }
  let repo: string | null = null;
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

/** How long one `git remote get-url` may take before it counts as a failure (a hung mount must not hold anything up). */
export const REPO_LOOKUP_TIMEOUT_MS = 3000;
/** How long an answer, or a failure, is kept before the next look. */
export const REPO_LOOKUP_TTL_MS = 5 * 60 * 1000;

const asyncByDir = new Map<string, { at: number; repo: string | null }>();
const lookups = new Map<string, Promise<string | null>>();

/** What the last look at a checkout found, even one past its expiry: undefined when it was never looked at. */
export const lastKnownRepo = (dir: string | null | undefined): string | null | undefined =>
  dir ? asyncByDir.get(dir)?.repo : null;

/**
 * Like `repoOfCheckout`, without blocking the process: git runs with a timeout and no shell, and the answer (a failure
 * too) is kept per checkout for `ttlMs`, so a fixed remote is picked up later. Callers asking while a look is running
 * share it. `run` and `now` are for tests.
 */
export function repoOfCheckoutAsync(
  dir: string | null | undefined,
  {
    ttlMs = REPO_LOOKUP_TTL_MS,
    timeoutMs = REPO_LOOKUP_TIMEOUT_MS,
    now = Date.now,
    run = runGitAsync,
  }: {
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
    run?: typeof runGitAsync;
  } = {},
): Promise<string | null> {
  if (!dir) {
    return Promise.resolve(null);
  }
  const kept = asyncByDir.get(dir);
  if (kept && now() - kept.at < ttlMs && now() >= kept.at) {
    return Promise.resolve(kept.repo);
  }
  const running = lookups.get(dir);
  if (running) {
    return running;
  }
  const lookup = run(dir, ['remote', 'get-url', 'origin'], { timeout: timeoutMs })
    .then((out) => (out.code === 0 ? repoOfRemote(out.stdout) : null))
    .catch(() => null)
    .then((repo) => {
      asyncByDir.set(dir, { at: now(), repo });
      lookups.delete(dir);
      return repo;
    });
  lookups.set(dir, lookup);
  return lookup;
}

/** Forget what was kept about checkouts, for tests. */
export function forgetRepoLookups(): void {
  asyncByDir.clear();
  lookups.clear();
}

/** A story's repo: a PR story's own, or a local story's checkout's origin. */
export function storyRepo(meta: StoryMeta | null | undefined): string | null {
  if (!meta) {
    return null;
  }
  if (meta.kind === 'local') {
    return meta.repo || repoOfCheckout(meta.repo_path);
  }
  return meta.repo || null;
}

const file = (home: string) => path.join(home, 'checkouts.json');
const readAll = (home: string) => readJson<Record<string, string>>(file(home), {}) || {};

/** Note where a repo's checkout is (from a local story, or a listener's working folder). */
export function seenCheckout(
  home: string,
  repo: string | null | undefined,
  dir: string | null | undefined,
): void {
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

/** Every checkout folder the bridge has recorded, whatever its repo, that still exists. */
export function seenCheckouts(home: string): string[] {
  return Object.values(readAll(home)).filter((dir) => typeof dir === 'string' && existsSync(dir));
}

/**
 * Where to work on a repo: the checkout the bridge has seen, else <dir>/<name> for each of config.json's
 * checkout_dirs (default ~/Development) when its origin is that repo, else null. ONCE_UPON_DEV_DIR overrides them.
 * dev: a checkout folder to look in instead.
 */
export function checkoutFor(
  home: string,
  repo: string | null | undefined,
  { dev }: { dev?: string } = {},
): string | null {
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
export const tilde = (dir: string): string =>
  dir && dir.startsWith(os.homedir() + path.sep) ? `~${dir.slice(os.homedir().length)}` : dir;
