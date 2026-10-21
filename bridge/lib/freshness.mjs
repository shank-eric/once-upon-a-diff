/**
 * Is a PR story up to date with the PR's latest commit? The story's meta
 * says which head it was told from (pr-story's pr.json headRefOid). The
 * bridge reads the PR's current head and, when it differs, what changed
 * between the two, with read-only `gh api` GETs cached for 60s:
 *   repos/{o}/{r}/pulls/{n}                       head.sha
 *   repos/{o}/{r}/compare/{story head}...{head}   commits and files since
 */
import { execFile } from 'node:child_process';
import { diffText } from './git.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { ghEnv } from './config.mjs';

const TTL_MS = 60000;
const cache = new Map();

function gh(args) {
  const env = ghEnv();
  return new Promise((resolve, reject) => {
    execFile(
      process.env.DIFF_STORY_GH || 'gh',
      ['api', ...args],
      { env, timeout: 20000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message).trim().split('\n')[0]));
        } else {
          resolve(JSON.parse(stdout));
        }
      },
    );
  });
}
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearFreshness = () => cache.clear();

/** A patch's hunks, old side: [{oldStart, oldLines}] */
const hunksOf = (patch) =>
  [...String(patch || '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((m) => ({
    oldStart: +m[1],
    oldLines: m[2] === undefined ? 1 : +m[2],
  }));
const KIND = { added: 'created', removed: 'deleted', renamed: 'renamed' };

/**
 * What changed from `sha` to the story's head: Map(path at `sha` -> {kind, hunks: [{oldStart, oldLines}]}).
 * A PR story asks gh's compare (read-only, cached 60s); a local story asks git. Throws when it can't tell.
 */
export async function changesSince(meta, sha) {
  const out = new Map();
  if (!sha || !meta.head_oid || sha === meta.head_oid) {
    return out;
  }
  if (meta.kind === 'local') {
    for (const f of parseUnifiedDiff(diffText(meta.repo_path, sha, meta.head_oid)).values()) {
      out.set(f.renamed_from || f.rel, {
        kind: f.kind,
        hunks: f.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines })),
      });
    }
    return out;
  }
  const cmp = await cached(`cmp ${meta.repo} ${sha} ${meta.head_oid}`, () =>
    gh([`repos/${meta.repo}/compare/${sha}...${meta.head_oid}`]),
  );
  for (const f of cmp.files || []) {
    out.set(f.previous_filename || f.filename, {
      kind: KIND[f.status] || 'modified',
      hunks: hunksOf(f.patch),
    });
  }
  return out;
}

/** How many commits `to` is ahead of `from` (gh compare, read-only, cached 60s with freshness's), or null. */
export async function newerCount(repo, from, to) {
  const cmp = await cached(`cmp ${repo} ${from} ${to}`, () =>
    gh([`repos/${repo}/compare/${from}...${to}`]),
  );
  return Number.isFinite(cmp.ahead_by)
    ? cmp.ahead_by
    : Array.isArray(cmp.commits)
      ? cmp.commits.length
      : null;
}

export const currentHead = (repo, number) =>
  cached(
    `head ${repo}#${number}`.toLowerCase(),
    async () => (await gh([`repos/${repo}/pulls/${Number(number)}`])).head.sha,
  );

const fileOf = (f) => (typeof f === 'string' ? f : f.rel);
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * An update that rewrote the story in place, with no "Since you read it" chapter for it: the last build for the PR was
 * a finished update from an older commit, and no chapter covers that range. Then the panel can still say what's new,
 * from GitHub's compare of the old head with the story's. Null when there's nothing to say or gh can't tell.
 * @returns {Promise<{from, to, newer, retold, at, changed_files, chapters_touched}|null>}
 */
export async function updatedInPlace(meta, chapters, lastBuild) {
  const b = lastBuild;
  const story = meta.head_oid;
  if (
    !b ||
    b.status !== 'done' ||
    b.mode !== 'update' ||
    !/^[0-9a-f]{7,40}$/.test(String(b.base_sha || '')) ||
    !story ||
    sameSha(b.base_sha, story)
  ) {
    return null;
  }
  if (chapters.some((ch) => ch.since && sameSha(ch.since.to, story))) {
    return null;
  } // a "Since you read it" chapter tells it
  let cmp;
  try {
    cmp = await cached(`cmp ${meta.repo} ${b.base_sha} ${story}`, () =>
      gh([`repos/${meta.repo}/compare/${b.base_sha}...${story}`]),
    );
  } catch {
    return null;
  }
  if (cmp.status === 'diverged' || cmp.status === 'behind') {
    return null;
  } // a rebase: the range diff wouldn't mean much
  const changed = (cmp.files || []).map((f) => f.filename);
  const set = new Set(changed);
  return {
    from: b.base_sha,
    to: story,
    retold: !!b.retell,
    at: b.done_at || null,
    newer: Number.isFinite(cmp.ahead_by) ? cmp.ahead_by : (cmp.commits || []).length,
    changed_files: changed,
    chapters_touched: chapters
      .map((ch, i) => ((ch.files || []).some((f) => set.has(fileOf(f))) ? i + 1 : 0))
      .filter(Boolean),
  };
}

/**
 * {state: 'current'|'stale'|'unknown', story_head, current_head, newer, rewritten, changed_files, chapters_touched, updated, error}
 * chapters_touched: the chapters that list a file changed since the story's head.
 * updated: on a current story, updatedInPlace() for the PR's last build (`lastBuild`, from builds.json), or null.
 */
export async function freshness(meta, chapters, { lastBuild = null } = {}) {
  const story = meta.head_oid || null;
  if (meta.kind !== 'github' || !meta.repo || !meta.number) {
    return { state: 'n/a' };
  }
  if (!story) {
    return {
      state: 'unknown',
      story_head: null,
      error: "the story doesn't say which commit it was told from (re-render it with pr-story)",
    };
  }
  let head;
  try {
    head = await currentHead(meta.repo, meta.number);
  } catch (e) {
    return {
      state: 'unknown',
      story_head: story,
      error: `couldn't read the PR's head with gh: ${e.message}`,
    };
  }
  if (head === story) {
    return {
      state: 'current',
      story_head: story,
      current_head: head,
      newer: 0,
      changed_files: [],
      chapters_touched: [],
      updated: await updatedInPlace(meta, chapters, lastBuild),
    };
  }
  let cmp;
  try {
    cmp = await cached(`cmp ${meta.repo} ${story} ${head}`, () =>
      gh([`repos/${meta.repo}/compare/${story}...${head}`]),
    );
  } catch (e) {
    return {
      state: 'stale',
      story_head: story,
      current_head: head,
      newer: null,
      changed_files: [],
      chapters_touched: [],
      error: `couldn't compare the commits: ${e.message}`,
    };
  }
  const changed = (cmp.files || []).map((f) => f.filename);
  const set = new Set(changed);
  const touched = chapters
    .map((ch, i) => ((ch.files || []).some((f) => set.has(fileOf(f))) ? i + 1 : 0))
    .filter(Boolean);
  return {
    state: 'stale',
    story_head: story,
    current_head: head,
    newer: Number.isFinite(cmp.ahead_by) ? cmp.ahead_by : (cmp.commits || []).length,
    rewritten: cmp.status === 'diverged' || cmp.status === 'behind', // a force-push or rebase since the story
    changed_files: changed,
    chapters_touched: touched,
  };
}
