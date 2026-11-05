/**
 * Which GitHub repo a story, a checkout or a listener is about, and where the
 * bridge has seen a checkout of each repo. Listeners are scoped per repo
 * (`once-upon wait --repo owner/name`), and the listen prompt
 * says which checkout to work from.
 *
 *   <home>/checkouts.json   {"owner/name": "/path/to/checkout"}, lowercased keys
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_RE } from '@once-upon-a-diff/domain/patterns';
import { readSettings } from './settings.ts';
import { runGitAsync, remoteUrl, topLevel, branchName } from '../../adapters/git.ts';
import { readJson, writeJsonAtomic } from '../../adapters/stores/fs/json-file.ts';
import { ensureDir } from '../../adapters/stores/fs/files.ts';
import { baseName } from '@once-upon-a-diff/domain/text';

export { REPO_RE };
export const sameRepo = (first: unknown, second: unknown): boolean =>
  !!first && !!second && String(first).toLowerCase() === String(second).toLowerCase();

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
/** github.com and its subdomains (`ssh.github.com`, an ssh alias like `work.github.com`), never `github.example.com`. */
const isGitHubHost = (host: string): boolean =>
  host === 'github.com' || host.endsWith('.github.com');
const isAzureHost = (host: string): boolean =>
  host === 'dev.azure.com' || host.endsWith('.dev.azure.com') || host.endsWith('.visualstudio.com');

export interface Remote {
  /** Lowercased, with no user or port. */
  host: string;
  /** Everything before the last path segment: `group/sub` or Azure DevOps `org/project` stay whole. */
  owner: string;
  name: string;
}

/**
 * Where a remote URL points, on any host: https (user:token@, port), `ssh://` (user, port) or scp-style
 * `git@host:path`. Azure DevOps' `_git` (https) and `v3` (ssh) markers are dropped, so both forms of one repo agree.
 * Local paths and `file:` URLs give null. This does not say the host is GitHub: `repoOfRemote` does, and every caller
 * that reaches `gh` or builds a github.com URL goes through that.
 */
export function parseRemote(url: string | null | undefined): Remote | null {
  const text = String(url || '').trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(text);
  let authority: string;
  let repoPath: string;
  let scpForm = false;
  if (scheme) {
    if (scheme[1].toLowerCase() === 'file') {
      return null;
    }
    authority = scheme[2];
    repoPath = scheme[3] || '';
  } else {
    const scp = /^([^/:\s]+):(?!\/\/)(.*)$/.exec(text);
    if (!scp) {
      return null;
    }
    authority = scp[1];
    repoPath = scp[2];
    scpForm = true;
  }
  const host = authority.replace(/^.*@/, '').replace(/:\d*$/, '').toLowerCase();
  // two characters at least: a drive letter (`C:/x/y`) is not a scp host
  // an underscore only appears in an ssh-config alias (`git@github_work:o/n`), which is never GitHub
  if (host.length < 2 || !(scpForm ? /^[a-z0-9._-]+$/ : /^[a-z0-9.-]+$/).test(host)) {
    return null;
  }
  const parts = repoPath
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (host.endsWith('dev.azure.com') && parts[0] === 'v3') {
    parts.shift();
  }
  const marker = parts.indexOf('_git');
  if (marker >= 0 && isAzureHost(host)) {
    parts.splice(marker, 1);
  }
  if (parts.length < 2 || !parts.every((part) => SEGMENT_RE.test(part))) {
    return null;
  }
  return { host, owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}

/**
 * owner/name from a GitHub remote URL (https or ssh), else null: a GitHub Enterprise, GitLab or Azure DevOps origin is
 * null here on purpose. The result goes to `gh`, to github.com URLs and into repo keys that become them.
 */
export function repoOfRemote(url: string | null | undefined): string | null {
  const remote = parseRemote(url);
  return remote && isGitHubHost(remote.host) && !remote.owner.includes('/')
    ? `${remote.owner}/${remote.name}`
    : null;
}

/**
 * Whether a remote URL, on any host, is the repo `repo` (owner/name) names. The last owner segment counts as the owner
 * (`Platform/dashifi` for Azure DevOps), so `acme/widgets` also accepts `group/acme/widgets`. That looseness is
 * deliberate: this only guards a local `git rev-parse` in a checkout the agent was started in, and never reaches gh.
 */
export function remoteNamed(
  url: string | null | undefined,
  repo: string | null | undefined,
): boolean {
  const remote = parseRemote(url);
  if (!remote || !repo) {
    return false;
  }
  const owners = [remote.owner, baseName(remote.owner)];
  return owners.some((owner) => sameRepo(`${owner}/${remote.name}`, repo));
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
    repo = repoOfRemote(remoteUrl(dir));
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
    ensureDir(home);
    writeJsonAtomic(file(home), all);
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

/** The top folder of the checkout `dir` is in. Throws outside a checkout. */
export const checkoutRoot = (dir: string): string => topLevel(dir);

/** The branch checked out in `dir`, or null when HEAD is detached or it is not a checkout. */
export const currentBranch = (dir: string): string | null => branchName(dir);
