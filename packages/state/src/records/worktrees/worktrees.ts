/**
 * Every git worktree on this Mac, for the board: what git says about each one, kept by a scanner that runs in the
 * background so the board's poll never waits on git.
 *
 *   discovery   the main checkouts of every repo the board knows of (the seeds the board passes: session folders, the
 *               folders ledger tasks name, checkouts the bridge has seen) plus a look in config.json's checkout_dirs two
 *               levels down for folders with a .git. A repo with no linked worktree is dropped. Every 10 minutes.
 *   each scan   `git worktree list --porcelain` per repo, then per worktree: the last commit's time, commits on no
 *               remote, whether it is in live (the main checkout's HEAD) or main (an ancestor), or superseded (every
 *               commit has a copy there: the same patch)
 *               (a merge check that times out keeps the last answer for the same tip)
 *   slower      clean or dirty (every 5 minutes, or when HEAD moved) and size on disk (every hour, one at a time)
 *
 * Every git call has a timeout and runs with `-c core.fsmonitor=false --no-optional-locks`: a wedged fsmonitor daemon
 * (everfi-frontend's worktrees have had them) or a lock must never hold the board up, and a status that times out keeps
 * its last answer and shows as unknown. Merged and superseded answers are kept per (branch tip, target tips), so they
 * are worked out again only when one moves. The result is saved to <home>/worktrees.json so a restart shows the last
 * answer at once, marked stale until a scan confirms it.
 *
 * `judge` is the one place that decides whether a worktree may be cleaned up; the board and the cleanup endpoint share it.
 */
import { agentId, canonicalRepo } from '@once-upon-a-diff/domain/ids';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoOfRemote, sameRepo } from '@once-upon-a-diff/foundation/repos';
import { readJson, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import type { BoardWorktree } from '@once-upon-a-diff/contracts/types';
import { type RunResult, type Runner, runCommand } from '@once-upon-a-diff/adapters/os';
import { gitVia } from '@once-upon-a-diff/adapters/git';
import { ensureDir } from '@once-upon-a-diff/adapters/stores/fs/files';
import { repoName } from '@once-upon-a-diff/domain/text';

/** One linked or main worktree as `git worktree list --porcelain` gives it. */
export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  /** why git thinks its folder is gone, when it does */
  prunable: string | null;
}

/** The entries of `git worktree list --porcelain` output, the main worktree first. */
export function parseWorktreeEntries(text: string): WorktreeEntry[] {
  const found: WorktreeEntry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const dir = lines.find((line) => line.startsWith('worktree '));
    if (!dir) {
      continue;
    }
    const branch = lines.find((line) => line.startsWith('branch '));
    const head = lines.find((line) => line.startsWith('HEAD '));
    const prunable = lines.find((line) => line === 'prunable' || line.startsWith('prunable '));
    found.push({
      path: dir.slice('worktree '.length).trim(),
      head: head ? head.slice('HEAD '.length).trim() : null,
      branch: branch
        ? branch
            .slice('branch '.length)
            .trim()
            .replace(/^refs\/heads\//, '')
        : null,
      detached: lines.includes('detached'),
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
      prunable: prunable ? prunable.slice('prunable'.length).trim() || 'prunable' : null,
    });
  }
  return found;
}

/**
 * A file of this name in a worktree's git dir keeps the worktree off the board. scripts/deploy-local.sh writes it in
 * its own reusable deploy worktree; any tool that owns a worktree the board should not list can do the same.
 */
export const HIDDEN_MARKER = 'once-upon-hidden';

/** Whether a linked worktree's git dir (named by the `gitdir:` line of its .git file) has the hidden marker. */
export function hiddenWorktree(dir: string): boolean {
  try {
    const line = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(dir, '.git'), 'utf8'));
    return !!line && existsSync(path.join(path.resolve(dir, line[1].trim()), HIDDEN_MARKER));
  } catch {
    return false;
  }
}

const SHORT_MS = 5000;
const STATUS_MS = 15000;
const SIZE_MS = 120000;
/** how long a scan's answers are kept before the next scan starts (it waits at least three times the last scan's length) */
const REFRESH_MS = 60 * 1000;
const DISCOVER_MS = 10 * 60 * 1000;
const STATUS_TTL_MS = 5 * 60 * 1000;
const SIZE_TTL_MS = 60 * 60 * 1000;
/** a worktree made this lately is never offered for cleanup */
const NEW_MS = 60 * 60 * 1000;
const MAX_CHERRY = 300;

const DEFAULT_BRANCHES = new Set(['main', 'master']);

/** Folders and files that are ignored because they are rebuilt (caches, build output, dependencies): not worth naming. */
const REGENERABLE_FOLDERS = new Set([
  'node_modules',
  '.output',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.vite',
  '__pycache__',
  'target',
  '.gradle',
  'tmp',
  '.yarn',
  '.pnp',
  '.wxt',
  '.eslintcache',
]);
const REGENERABLE_FILE =
  /(^|\/)(\.DS_Store|\.eslintcache|\.prettiercache)$|\.(tsbuildinfo|log)$|^\.husky\/_(\/|$)/;
const MAX_IGNORED = 30;

/** Ignored paths from `git status --ignored=matching` lines (`!! path`) that are not rebuilt, sorted and capped. */
export function irreplaceableIgnored(lines: string[]): string[] {
  const found = lines
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(
      (name) =>
        !!name &&
        !name.split('/').some((part) => REGENERABLE_FOLDERS.has(part)) &&
        !REGENERABLE_FILE.test(name),
    );
  return found.sort().slice(0, MAX_IGNORED);
}

/** What git says about one worktree. */
export interface WorktreeFacts {
  path: string;
  main: string;
  /** the branch the main checkout is on, null when detached */
  mainBranch: string | null;
  repo: string | null;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  lastCommitMs: number | null;
  /** when the folder was made (ms), null when unknown */
  created: number | null;
  /** the branch has never moved from where it was created (its reflog has one entry) */
  unmoved: boolean;
  modified: number | null;
  untracked: number | null;
  /** the HEAD the status was taken at, and when */
  statusHead: string | null;
  statusAt: number | null;
  unpushed: number | null;
  sizeKb: number | null;
  sizeAt: number | null;
  /** the repo's default branch: origin/HEAD's, else init.defaultBranch, else main or master */
  defaultBranch: string | null;
  /** the tip is an ancestor of the default branch, or of the main checkout's own branch when that is built on it (null: could not tell) */
  merged: boolean | null;
  /**
   * not merged, but each commit has a copy there: the same patch, by `git cherry` (null: could not tell).
   */
  superseded: boolean | null;
  /** a branch whose tip is also origin's branch of the same name (a review checkout: nothing local) */
  onRemote: boolean;
  /** a detached HEAD that some branch (local or remote) reaches; true for a branch */
  reachable: boolean | null;
  /** ignored files that cannot be rebuilt (.env, *.local.json, ...), from the last status */
  ignored: string[];
  /** a removal failed or timed out: it needs a look, and Clean up is not offered again */
  attention?: string;
  /** read from worktrees.json and not yet confirmed by a scan in this process */
  loaded?: boolean;
}

interface MainInfo {
  path: string;
  repo: string | null;
  branch: string | null;
}

interface Target {
  ref: string;
  sha: string;
}

/**
 * What a branch counts as merged into: the default branch (local and origin's) and the main checkout's own branch when
 * that is built on the default. The main checkout's detached HEAD is never a target: a commit only it holds is one
 * rebuilt checkout from being lost.
 */
interface Targets {
  defaultBranch: string | null;
  list: Target[];
}

export interface Scan {
  /** when the last scan finished (ms), null before the first */
  finished: number | null;
  scanning: boolean;
  items: WorktreeFacts[];
  prunable: { path: string; repo: string | null; line: string }[];
}

export interface ScannerOptions {
  home: string;
  /** config.json's checkout_dirs */
  dirs: () => string[];
  /** called when what read() returns changed */
  onChange?: () => void;
  run?: Runner;
  now?: () => number;
}

/** Runs `fn` over `items`, at most `size` at once. */
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item).catch(() => undefined);
      }
    }),
  );
}

const real = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

export class WorktreeScanner {
  private home: string;
  private dirs: () => string[];
  private onChange: () => void;
  private run: Runner;
  private now: () => number;
  private mains = new Map<string, MainInfo>();
  private discoveredAt = 0;
  private items = new Map<string, WorktreeFacts>();
  private prunable: Scan['prunable'] = [];
  private seeds: string[] = [];
  private finishedAt: number | null = null;
  private running: Promise<void> | null = null;
  private lastStart = 0;
  private lastLength = 0;
  /** merged and superseded answers, by tip and targets */
  private judged = new Map<string, { merged: boolean; superseded: boolean }>();
  /** whether a branch has never moved, by branch and tip */
  private unmovedBy = new Map<string, boolean>();
  /** paths just removed and when, so a scan that began before cannot bring them back */
  private forgotten = new Map<string, number>();

  constructor(options: ScannerOptions) {
    this.home = options.home;
    this.dirs = options.dirs;
    this.onChange = options.onChange ?? (() => undefined);
    this.run = options.run ?? runCommand;
    this.now = options.now ?? Date.now;
    const saved = readJson<{ at?: number; items?: WorktreeFacts[] }>(this.file(), {}) || {};
    for (const item of Array.isArray(saved.items) ? saved.items : []) {
      if (item && typeof item.path === 'string' && typeof item.main === 'string') {
        // what an earlier bridge saw of clean or dirty is not an answer until a status confirms it
        this.items.set(item.path, { ...item, modified: null, untracked: null, loaded: true });
      }
    }
  }

  private file(): string {
    return path.join(this.home, 'worktrees.json');
  }

  /** What the scanner knows now. Memory only. */
  read(): Scan {
    return {
      finished: this.finishedAt,
      scanning: !!this.running,
      items: [...this.items.values()],
      prunable: this.prunable,
    };
  }

  /** The facts of a worktree the scanner lists, by path. */
  find(dir: string): WorktreeFacts | null {
    const wanted = real(dir);
    for (const item of this.items.values()) {
      if (item.path === dir || real(item.path) === wanted) {
        return item;
      }
    }
    return null;
  }

  /** Forgets a worktree (it was just removed). */
  forget(dir: string): void {
    const found = this.find(dir);
    if (found) {
      this.items.delete(found.path);
      this.forgotten.set(found.path, this.now());
      this.onChange();
    }
  }

  /** A removal failed: the worktree shows "needs attention" and Clean up is not offered for it again. */
  markAttention(dir: string, message: string): void {
    const found = this.find(dir);
    if (found) {
      found.attention = message;
      this.save();
      this.onChange();
    }
  }

  /**
   * Starts a scan in the background unless one is running or the last was lately; `seeds` are folders of repos the
   * board knows of. Never waits.
   */
  kick(seeds: string[] = []): void {
    this.seeds = seeds;
    const now = this.now();
    if (this.running || now - this.lastStart < Math.max(REFRESH_MS, this.lastLength * 3)) {
      return;
    }
    this.lastStart = now;
    const started = this.now();
    this.running = this.scan()
      .catch(() => undefined)
      .finally(() => {
        this.lastLength = this.now() - started;
        this.running = null;
        this.finishedAt = this.now();
        this.save();
        this.onChange();
      });
  }

  /** Resolves when the scan in flight is done (tests). */
  async idle(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  private git(cwd: string, args: string[], timeoutMs = SHORT_MS): Promise<RunResult> {
    return gitVia(this.run, cwd, args, timeoutMs);
  }

  private save(): void {
    try {
      ensureDir(this.home);
      writeJsonAtomic(this.file(), { at: this.finishedAt, items: [...this.items.values()] });
    } catch {
      /* a convenience */
    }
  }

  private async scan(): Promise<void> {
    if (!this.mains.size || this.now() - this.discoveredAt > DISCOVER_MS) {
      await this.discover();
    }
    const next = new Map<string, WorktreeFacts>();
    const prunable: Scan['prunable'] = [];
    const queue: { entry: WorktreeEntry; main: MainInfo; targets: Targets }[] = [];
    const began = this.now();
    await pool([...this.mains.values()], 4, async (main) => {
      const listed = await this.git(main.path, ['worktree', 'list', '--porcelain']);
      if (listed.code !== 0) {
        // keep what was known of this repo
        for (const [key, item] of this.items) {
          if (item.main === main.path) {
            next.set(key, item);
          }
        }
        return;
      }
      const entries = parseWorktreeEntries(listed.stdout);
      const targets = await this.targetsOf(main);
      for (const entry of entries.slice(1)) {
        if (entry.prunable) {
          prunable.push({
            path: entry.path,
            repo: main.repo,
            line: `git -C ${main.path} worktree prune`,
          });
        } else if (!hiddenWorktree(entry.path)) {
          queue.push({ entry, main, targets });
        }
      }
    });
    // stage 1: the cheap facts, and merged or superseded
    await pool(queue, 4, async ({ entry, main, targets }) => {
      next.set(entry.path, await this.cheap(entry, main, targets, this.items.get(entry.path)));
    });
    // a worktree removed while this scan ran stays gone, and a forgotten path git no longer lists is let go
    for (const [gone, when] of this.forgotten) {
      if (when >= began) {
        next.delete(gone);
      } else if (!queue.some((one) => one.entry.path === gone)) {
        this.forgotten.delete(gone);
      }
    }
    if (this.judged.size > 2000) {
      this.judged.clear();
    }
    if (this.unmovedBy.size > 2000) {
      this.unmovedBy.clear();
    }
    this.items = next;
    this.prunable = prunable;
    this.onChange();
    // stage 2: clean or dirty, for those not looked at lately (or whose HEAD moved)
    const now = this.now();
    const due = [...this.items.values()].filter(
      (item) =>
        item.statusAt === null ||
        now - item.statusAt > STATUS_TTL_MS ||
        item.statusHead !== item.head,
    );
    await pool(due, 2, async (item) => {
      await this.status(item);
    });
    this.onChange();
    // stage 3: size, one at a time
    const sized = [...this.items.values()].filter(
      (item) => item.sizeAt === null || now - item.sizeAt > SIZE_TTL_MS,
    );
    await pool(sized, 1, async (item) => {
      const out = await this.run('du', ['-sk', item.path], SIZE_MS);
      const kilobytes = out.code === 0 ? Number.parseInt(out.stdout) : NaN;
      if (Number.isFinite(kilobytes)) {
        item.sizeKb = kilobytes;
        item.sizeAt = this.now();
      }
    });
  }

  /** The main checkouts of the repos with linked worktrees. */
  private async discover(): Promise<void> {
    const candidates = new Set<string>(this.seeds);
    for (const dir of this.dirs()) {
      for (const found of await foldersWithGit(dir, 2)) {
        candidates.add(found);
      }
    }
    const mains = new Map<string, MainInfo>();
    await pool([...candidates], 4, async (dir) => {
      const listed = await this.git(dir, ['worktree', 'list', '--porcelain']);
      if (listed.code !== 0) {
        return;
      }
      const entries = parseWorktreeEntries(listed.stdout);
      if (entries.length < 2) {
        return;
      }
      const key = real(entries[0].path);
      if (mains.has(key)) {
        return;
      }
      const remote = await this.git(entries[0].path, ['remote', 'get-url', 'origin']);
      mains.set(key, {
        path: entries[0].path,
        repo: remote.code === 0 ? repoOfRemote(remote.stdout) : null,
        branch: entries[0].branch,
      });
    });
    this.mains = mains;
    this.discoveredAt = this.now();
  }

  /**
   * What the repo's work is merged into (see Targets). The default branch is origin/HEAD's, else init.defaultBranch, else
   * main or master, whichever has a ref.
   */
  private async targetsOf(main: MainInfo): Promise<Targets> {
    const names: string[] = [];
    const origin = await this.git(main.path, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    const fromOrigin = origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, '') : '';
    if (fromOrigin) {
      names.push(fromOrigin);
    }
    const init = await this.git(main.path, ['config', '--get', 'init.defaultBranch']);
    if (init.code === 0 && init.stdout.trim()) {
      names.push(init.stdout.trim());
    }
    const lookup = async (candidates: string[]) => {
      const found: Target[] = [];
      if (!candidates.length) {
        return found;
      }
      const refs = await this.git(main.path, [
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        ...candidates.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`]),
      ]);
      for (const line of refs.code === 0 ? refs.stdout.split('\n') : []) {
        const [sha, ref] = line.trim().split(' ');
        if (sha && ref) {
          found.push({ ref, sha });
        }
      }
      return found;
    };
    let list = await lookup([...new Set(names)]);
    let defaultBranch: string | null = null;
    if (list.length) {
      defaultBranch = list[0].ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    } else {
      list = await lookup(['main', 'master']);
      defaultBranch = list.length
        ? list[0].ref.replace(/^refs\/(heads|remotes\/origin)\//, '')
        : null;
    }
    // the main checkout's own branch, when it is built on the default (larmor's phone/live): work in it is not lost
    const attached = await this.git(main.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = attached.code === 0 ? attached.stdout.trim() : '';
    if (branch && !list.some((target) => target.ref === `refs/heads/${branch}`)) {
      const tip = await this.git(main.path, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      const sha = tip.code === 0 ? tip.stdout.trim() : '';
      const builtOn = list.length
        ? await Promise.all(
            list.map((target) =>
              this.git(main.path, ['merge-base', '--is-ancestor', target.sha, sha]),
            ),
          )
        : [];
      if (sha && builtOn.some((check) => check.code === 0)) {
        list.push({ ref: `refs/heads/${branch}`, sha });
      }
    }
    return { defaultBranch, list };
  }

  private async cheap(
    entry: WorktreeEntry,
    main: MainInfo,
    targets: Targets,
    before: WorktreeFacts | undefined,
  ): Promise<WorktreeFacts> {
    const dir = entry.path;
    const ref = entry.branch && !entry.detached ? `refs/heads/${entry.branch}` : 'HEAD';
    const [date, unpushed] = await Promise.all([
      this.git(dir, ['log', '-1', '--format=%ct', 'HEAD']),
      this.git(dir, ['rev-list', '--count', ref, '--not', '--remotes', '--']),
    ]);
    const seconds = date.code === 0 ? Number(date.stdout.trim()) : NaN;
    const count = unpushed.code === 0 ? Number.parseInt(unpushed.stdout) : NaN;
    let created: number | null = null;
    try {
      created = statSync(dir).birthtimeMs || null;
    } catch {
      created = null;
    }
    const tip = entry.head;
    // a check that timed out keeps the last answer for the same tip: a branch must not read unknown for one scan
    const kept =
      before && before.head === tip && before.merged !== null && before.superseded !== null
        ? { merged: before.merged, superseded: before.superseded }
        : null;
    const outcome = (tip ? await this.mergeState(main, targets, entry, tip) : null) ?? kept;
    const branch = entry.detached ? null : entry.branch;
    const remote = branch
      ? await this.git(main.path, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${branch}`,
        ])
      : null;
    let reachable: boolean | null = true;
    if (entry.detached) {
      reachable = tip ? await this.reaches(main, tip) : null;
    }
    return {
      path: dir,
      main: main.path,
      mainBranch: main.branch,
      repo: main.repo,
      branch,
      head: tip,
      detached: entry.detached,
      locked: entry.locked,
      lastCommitMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      created,
      unmoved: entry.branch && tip ? await this.neverMoved(main, entry.branch, tip) : false,
      // what was saved by an earlier bridge is not a clean or dirty answer until a status confirms it
      modified: before?.loaded ? null : (before?.modified ?? null),
      untracked: before?.loaded ? null : (before?.untracked ?? null),
      statusHead: before?.statusHead ?? null,
      statusAt: before?.loaded ? null : (before?.statusAt ?? null),
      unpushed: Number.isFinite(count) ? count : null,
      sizeKb: before?.sizeKb ?? null,
      sizeAt: before?.sizeAt ?? null,
      defaultBranch: targets.defaultBranch,
      merged: outcome ? outcome.merged : null,
      superseded: outcome ? outcome.superseded : null,
      onRemote: !!remote && remote.code === 0 && !!tip && remote.stdout.trim() === tip,
      reachable,
      ignored: before?.loaded ? [] : (before?.ignored ?? []),
      ...(before?.attention ? { attention: before.attention } : {}),
    };
  }

  /** Whether some branch, local or remote, reaches a commit (a detached HEAD's commits are safe only if one does). null: could not tell. */
  private async reaches(main: MainInfo, sha: string): Promise<boolean | null> {
    const out = await this.git(main.path, [
      'for-each-ref',
      '--count=1',
      '--contains',
      sha,
      '--format=%(refname)',
      'refs/heads',
      'refs/remotes',
    ]);
    if (out.code !== 0 || out.timedOut) {
      return null;
    }
    return out.stdout.trim().length > 0;
  }

  /** Whether the branch still stands where it was created: its reflog has one entry (or its first and last are the same). */
  private async neverMoved(main: MainInfo, branch: string, tip: string): Promise<boolean> {
    const key = `${main.path}@${branch}@${tip}`;
    const kept = this.unmovedBy.get(key);
    if (kept !== undefined) {
      return kept;
    }
    const log = await this.git(main.path, [
      'reflog',
      'show',
      '--format=%H',
      `refs/heads/${branch}`,
    ]);
    const shas = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [];
    const unmoved = shas.length <= 1 || shas[0] === shas[shas.length - 1];
    this.unmovedBy.set(key, unmoved);
    return unmoved;
  }

  /** Merged (the tip is an ancestor of a target) or superseded (each commit has a copy in a target), kept per tip and targets. */
  private async mergeState(
    main: MainInfo,
    targets: Targets,
    entry: WorktreeEntry,
    tip: string,
  ): Promise<{ merged: boolean; superseded: boolean } | null> {
    // the worktree's own branch is not something it is merged into
    const own = entry.branch ? `refs/heads/${entry.branch}` : null;
    const into = targets.list.filter((target) => target.ref !== own && target.sha !== tip);
    const intoAll = targets.list.filter((target) => target.ref !== own);
    const key = `${tip}|${intoAll.map((target) => target.sha).join(',')}|${own ?? ''}`;
    const kept = this.judged.get(key);
    if (kept) {
      return kept;
    }
    if (!intoAll.length) {
      return null;
    }
    let merged = false;
    for (const target of intoAll) {
      const check = await this.git(main.path, ['merge-base', '--is-ancestor', tip, target.sha]);
      if (check.timedOut) {
        return null;
      }
      if (check.code === 0) {
        merged = true;
        break;
      }
    }
    let superseded = false;
    if (!merged) {
      for (const target of into) {
        if (await this.copiedIn(main, tip, target)) {
          superseded = true;
          break;
        }
      }
    }
    const result = { merged, superseded };
    this.judged.set(key, result);
    return result;
  }

  /** Whether every commit of the tip that the target lacks has a copy there: `git cherry` says so (the same patch). */
  private async copiedIn(main: MainInfo, tip: string, target: Target): Promise<boolean> {
    const cherry = await this.git(main.path, ['cherry', target.sha, tip], 20000);
    if (cherry.code !== 0 || cherry.timedOut) {
      return false;
    }
    const lines = cherry.stdout.split('\n').filter(Boolean);
    if (!lines.length || lines.length > MAX_CHERRY) {
      return false;
    }
    return !lines.some((line) => line.startsWith('+ '));
  }

  /** Clean or dirty. A timeout or failure keeps the last answer. */
  private async status(item: WorktreeFacts, timeoutMs = STATUS_MS): Promise<void> {
    const out = await this.git(
      item.path,
      ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching'],
      timeoutMs,
    );
    if (out.code !== 0 || out.timedOut) {
      return;
    }
    const lines = out.stdout.split('\n').filter(Boolean);
    item.untracked = lines.filter((line) => line.startsWith('??')).length;
    item.modified = lines.filter((line) => !line.startsWith('??') && !line.startsWith('!!')).length;
    item.ignored = irreplaceableIgnored(lines);
    item.statusHead = item.head;
    item.statusAt = this.now();
    item.loaded = false;
  }

  /**
   * The facts of one worktree worked out now, not from what was kept: the cleanup endpoint's own look. null when git
   * no longer lists it. The status is taken afresh and a timeout leaves it unknown.
   */
  async refreshOne(dir: string): Promise<WorktreeFacts | null> {
    const known = this.find(dir);
    if (!known) {
      return null;
    }
    const main = this.mains.get(real(known.main)) ?? {
      path: known.main,
      repo: known.repo,
      branch: known.mainBranch,
    };
    const listed = await this.git(main.path, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) {
      return null;
    }
    const entry = parseWorktreeEntries(listed.stdout)
      .slice(1)
      .find((one) => one.path === known.path);
    if (!entry || entry.prunable) {
      return null;
    }
    const targets = await this.targetsOf(main);
    const fresh = await this.cheap(entry, main, targets, {
      ...known,
      statusAt: null,
      loaded: false,
    });
    fresh.ignored = [];
    fresh.modified = null;
    fresh.untracked = null;
    fresh.statusAt = null;
    await this.status(fresh);
    this.items.set(fresh.path, fresh);
    this.onChange();
    return fresh;
  }
}

/** Folders at most `depth` levels down that hold a .git (a repo's main checkout), not looking inside one or inside node_modules. */
async function foldersWithGit(dir: string, depth: number): Promise<string[]> {
  const holds = async (folder: string) => {
    try {
      statSync(path.join(folder, '.git'));
      return true;
    } catch {
      return false;
    }
  };
  if (await holds(dir)) {
    return [dir];
  }
  if (depth < 1) {
    return [];
  }
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter(
        (child) =>
          child.isDirectory() && child.name !== 'node_modules' && !child.name.startsWith('.'),
      )
      .map((child) => child.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    found.push(...(await foldersWithGit(path.join(dir, name), depth - 1)));
  }
  return found;
}

/** What the board knows around a worktree that git does not. */
export interface JudgeContext {
  /** live sessions and open registered agents whose folder is in it */
  inUse: BoardWorktree['in_use'];
  pr: BoardWorktree['pr'];
  /** repos whose branches are never deleted (names, lowercase) */
  keepBranches: string[];
  /** now (ms) */
  now: number;
}

/** The agent states that count as open: an agent is registered in the agent registry, which this folder doesn't import, so it names the few fields it reads. */
type AgentRunState = 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
interface RegisteredAgent {
  sid: string;
  name: string;
  state: AgentRunState;
  cwd?: string | null;
  repo?: string | null;
  branch?: string | null;
}
const OPEN_AGENT: AgentRunState[] = ['running', 'waiting', 'plan', 'fixing'];
const inside = (dir: string, parent: string): boolean =>
  dir === parent || dir.startsWith(parent + path.sep);

/**
 * Who is working in a worktree: live sessions whose folder is in it, and open registered agents whose cwd is in it or
 * whose registered repo and branch are the worktree's (an agent is registered from the launcher's folder, so its cwd
 * is often the main checkout). Each by id; nothing is matched by name or task text. A worktree something works in is
 * never cleaned up. An agent's id is `<sid8>:<name>`.
 */
export function workingIn(
  dir: string,
  sessions: { id: string; title: string; cwd: string }[],
  agents: RegisteredAgent[],
  tree: { repo: string | null; branch: string | null } = { repo: null, branch: null },
): BoardWorktree['in_use'] {
  const within = (cwd: string): boolean =>
    [dir, real(dir)].some((one) => inside(cwd, one) || inside(real(cwd), one));
  const who: BoardWorktree['in_use'] = sessions
    .filter((session) => within(session.cwd))
    .map((session) => ({ kind: 'session', id: session.id, label: session.title }));
  for (const agent of agents) {
    if (!OPEN_AGENT.includes(agent.state)) {
      continue;
    }
    const onBranch =
      !!tree.branch &&
      agent.branch === tree.branch &&
      (!agent.repo || !tree.repo || sameRepo(agent.repo, tree.repo));
    if (onBranch || (!!agent.cwd && within(agent.cwd))) {
      who.push({ kind: 'agent', id: agentId(agent.sid, agent.name), label: agent.name });
    }
  }
  return who.filter(
    (one, index) =>
      who.findIndex((other) => other.kind === one.kind && other.id === one.id) === index,
  );
}

/** Whether a repo's branches are on the never-delete list: by owner/name, name, or the main checkout's folder. */
export function branchesKept(facts: Pick<WorktreeFacts, 'repo' | 'main'>, keep: string[]): boolean {
  const names = [facts.repo, repoName(facts.repo), path.basename(facts.main)].map((name) =>
    (name ?? '').toLowerCase(),
  );
  return keep.some((name) => !!name && names.includes(name.toLowerCase()));
}

const stateOf = (unknown: boolean, dirty: boolean): BoardWorktree['state'] => {
  if (unknown) {
    return 'unknown';
  }
  return dirty ? 'dirty' : 'clean';
};

/**
 * The board's view of a worktree, and whether Clean up may be offered: clean (status known), nothing working in it, not
 * locked, not new, and its work is in live or main, or superseded there, or its PR merged with nothing unpushed.
 * Unpushed commits only matter when it is none of merged or superseded. Pure.
 */
export function judge(facts: WorktreeFacts, context: JudgeContext): BoardWorktree {
  // a branch that never moved is new work, unless origin has it too (a review checkout: nothing is local)
  const isNew =
    (!!facts.branch && facts.unmoved && !facts.onRemote) ||
    (facts.created !== null && context.now - facts.created < NEW_MS);
  let verdict: BoardWorktree['verdict'];
  if (isNew) {
    verdict = 'new';
  } else if (facts.merged) {
    verdict = 'merged';
  } else if (facts.superseded) {
    verdict = 'superseded';
  } else if (context.pr.state === 'merged') {
    verdict = 'pr_merged';
  } else if (!!facts.branch && facts.unmoved && facts.onRemote) {
    verdict = 'pushed';
  } else if (facts.merged === null) {
    verdict = 'unknown';
  } else {
    verdict = 'unmerged';
  }
  const stale = !!facts.loaded;
  const keep: string[] = [];
  const dirty = (facts.modified ?? 0) + (facts.untracked ?? 0) > 0;
  const unknownStatus = facts.modified === null || facts.untracked === null;
  const onDefault =
    !!facts.branch &&
    (DEFAULT_BRANCHES.has(facts.branch) ||
      facts.branch === facts.mainBranch ||
      facts.branch === facts.defaultBranch);
  if (facts.attention) {
    keep.push(`needs attention: ${facts.attention}`);
  }
  if (facts.detached && facts.reachable !== true) {
    keep.push('its HEAD is on no branch, so removing it would lose the commits');
  }
  if (stale) {
    keep.push('scanning');
  }
  if (context.inUse.length) {
    keep.push(`in use by ${context.inUse.map((one) => one.label).join(', ')}`);
  }
  if (facts.locked) {
    keep.push('locked');
  }
  if (onDefault) {
    keep.push('on the default branch');
  }
  if (unknownStatus) {
    keep.push('clean or dirty not known');
  } else if (dirty) {
    keep.push(`dirty (${facts.modified} modified, ${facts.untracked} untracked)`);
  }
  if (verdict === 'new') {
    keep.push(
      facts.branch && facts.unmoved ? 'no commits of its own yet' : 'made less than an hour ago',
    );
  } else if (verdict === 'unmerged') {
    keep.push('not in the main line');
  } else if (verdict === 'unknown') {
    keep.push('merge state not known');
  }
  const inMain = verdict === 'merged' || verdict === 'superseded' || verdict === 'pushed';
  if (!inMain) {
    if (facts.unpushed === null) {
      keep.push('unpushed commits not known');
    } else if (facts.unpushed > 0) {
      keep.push(`${facts.unpushed} unpushed`);
    }
  }
  if (context.pr.state === 'open' && !inMain) {
    keep.push(`PR #${context.pr.number} open`);
  }
  const removable = keep.length === 0;
  return {
    path: facts.path,
    name: path.basename(facts.path),
    repo: facts.repo,
    lane: canonicalRepo(facts.repo) ?? path.basename(facts.main),
    main: facts.main,
    branch: facts.branch,
    last_commit_at: facts.lastCommitMs ? new Date(facts.lastCommitMs).toISOString() : null,
    state: stateOf(unknownStatus, dirty),
    modified: facts.modified,
    untracked: facts.untracked,
    unpushed: facts.unpushed,
    size_kb: facts.sizeKb,
    pr: context.pr,
    verdict,
    in_use: context.inUse,
    locked: facts.locked,
    ignored: facts.ignored ?? [],
    attention: facts.attention ?? null,
    stale,
    removable,
    keep,
    deletes_branch:
      removable &&
      verdict === 'merged' &&
      !!facts.branch &&
      !onDefault &&
      !branchesKept(facts, context.keepBranches),
  };
}
