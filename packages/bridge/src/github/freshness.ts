/**
 * Is a PR story up to date with the PR's latest commit? The story's meta
 * says which head it was told from (once-upon's pr.json headRefOid). The
 * bridge reads the PR's current head and, when it differs, what changed
 * between the two, with read-only `gh api` GETs cached for 60s:
 *   repos/{o}/{r}/pulls/{n}                       head.sha
 *   repos/{o}/{r}/compare/{story head}...{head}   commits and files since
 */
import { diffText } from '../util/git.ts';
import { parseUnifiedDiff } from '../util/diff.ts';
import { runGh } from '../util/gh.ts';
import { prKey } from '@once-upon-a-diff/shared/util/github-paths';
import { SHA_RE, sameSha } from '@once-upon-a-diff/shared/util/text';
import type { DiffFile, FreshUpdate, Freshness } from '@once-upon-a-diff/shared/types';
import type { Build } from '../inbox/builds.ts';
import type { PlanFile } from '../stories/chapters.ts';
import type { StoryMeta } from '../types.ts';

/** GitHub's compare of two commits: just what's read here. */
interface GhCompare {
  status?: string;
  ahead_by?: number;
  commits?: unknown[];
  files?: { filename: string; previous_filename?: string; status?: string; patch?: string }[];
}

/** What changed in a file since a commit: its kind, and its hunks' old sides. */
export interface FileChange {
  kind: DiffFile['kind'];
  hunks: { oldStart: number; oldLines: number }[];
}

/** The chapters as freshness reads them: their files, and a "Since you read it" range. */
type ChapterFiles = { files?: PlanFile[]; since?: { to: string } };

const TTL_MS = 60000;
const cache = new Map<string, { at: number; value: unknown }>();

async function ghApiJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await runGh(['api', ...args]));
}
async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value as T;
  }
  const value = await compute();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearFreshness = () => cache.clear();

/** A patch's hunks, old side: [{oldStart, oldLines}] */
const hunksOf = (patch: string | undefined) =>
  [...String(patch || '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((match) => ({
    oldStart: +match[1],
    oldLines: match[2] === undefined ? 1 : +match[2],
  }));
const KIND: Record<string, DiffFile['kind']> = {
  added: 'created',
  removed: 'deleted',
  renamed: 'renamed',
};

/**
 * What changed from `sha` to the story's head: Map(path at `sha` -> {kind, hunks: [{oldStart, oldLines}]}).
 * A PR story asks gh's compare (read-only, cached 60s); a local story asks git. Throws when it can't tell.
 */
export async function changesSince(
  meta: StoryMeta,
  sha: string | null,
): Promise<Map<string, FileChange>> {
  const out = new Map<string, FileChange>();
  if (!sha || !meta.head_oid || sha === meta.head_oid) {
    return out;
  }
  if (meta.kind === 'local') {
    for (const file of parseUnifiedDiff(
      diffText(meta.repo_path as string, sha, meta.head_oid),
    ).values()) {
      out.set(file.renamed_from || file.rel, {
        kind: file.kind,
        hunks: file.hunks.map((hunk) => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines })),
      });
    }
    return out;
  }
  const cmp = await cached(`cmp ${meta.repo} ${sha} ${meta.head_oid}`, () =>
    ghApiJson<GhCompare>([`repos/${meta.repo}/compare/${sha}...${meta.head_oid}`]),
  );
  for (const file of cmp.files || []) {
    out.set(file.previous_filename || file.filename, {
      kind: KIND[file.status as string] || 'modified',
      hunks: hunksOf(file.patch),
    });
  }
  return out;
}

/** How many commits `to` is ahead of `from` (gh compare, read-only, cached 60s with freshness's), or null. */
export async function newerCount(
  repo: string,
  from: string,
  toSha: string,
): Promise<number | null> {
  const cmp = await cached(`cmp ${repo} ${from} ${toSha}`, () =>
    ghApiJson<GhCompare>([`repos/${repo}/compare/${from}...${toSha}`]),
  );
  if (Number.isFinite(cmp.ahead_by)) {
    return cmp.ahead_by as number;
  }
  return Array.isArray(cmp.commits) ? cmp.commits.length : null;
}

export const currentHead = (repo: string, number: number | string): Promise<string> =>
  cached(
    `head ${prKey(repo, number)}`,
    async () =>
      (await ghApiJson<{ head: { sha: string } }>([`repos/${repo}/pulls/${Number(number)}`])).head
        .sha,
  );

const fileOf = (file: PlanFile) => (typeof file === 'string' ? file : file.rel);

/**
 * An update that rewrote the story in place, with no "Since you read it" chapter for it: the last build for the PR was
 * a finished update from an older commit, and no chapter covers that range. Then the panel can still say what's new,
 * from GitHub's compare of the old head with the story's. Null when there's nothing to say or gh can't tell.
 */
export async function updatedInPlace(
  meta: StoryMeta,
  chapters: ChapterFiles[],
  lastBuild: Build | null,
): Promise<FreshUpdate | null> {
  const build = lastBuild;
  const story = meta.head_oid;
  if (
    !build ||
    build.status !== 'done' ||
    build.mode !== 'update' ||
    !SHA_RE.test(String(build.base_sha || '')) ||
    !story ||
    sameSha(build.base_sha, story)
  ) {
    return null;
  }
  if (chapters.some((chapter) => chapter.since && sameSha(chapter.since.to, story))) {
    return null;
  } // a "Since you read it" chapter tells it
  let cmp: GhCompare;
  try {
    cmp = await cached(`cmp ${meta.repo} ${build.base_sha} ${story}`, () =>
      ghApiJson<GhCompare>([`repos/${meta.repo}/compare/${build.base_sha}...${story}`]),
    );
  } catch {
    return null;
  }
  if (cmp.status === 'diverged' || cmp.status === 'behind') {
    return null;
  } // a rebase: the range diff wouldn't mean much
  const changed = (cmp.files || []).map((file) => file.filename);
  const set = new Set(changed);
  return {
    from: build.base_sha as string,
    to: story,
    retold: !!build.retell,
    at: build.done_at || null,
    newer: Number.isFinite(cmp.ahead_by) ? (cmp.ahead_by as number) : (cmp.commits || []).length,
    changed_files: changed,
    chapters_touched: chapters
      .map((chapter, i) =>
        (chapter.files || []).some((file) => set.has(fileOf(file))) ? i + 1 : 0,
      )
      .filter(Boolean),
  };
}

/**
 * {state: 'current'|'stale'|'unknown', story_head, current_head, newer, rewritten, changed_files, chapters_touched, updated, error}
 * chapters_touched: the chapters that list a file changed since the story's head.
 * updated: on a current story, updatedInPlace() for the PR's last build (`lastBuild`, from builds.json), or null.
 */
export async function freshness(
  meta: StoryMeta,
  chapters: ChapterFiles[],
  { lastBuild = null }: { lastBuild?: Build | null } = {},
): Promise<Freshness> {
  const story = meta.head_oid || null;
  if (meta.kind !== 'github' || !meta.repo || !meta.number) {
    return { state: 'n/a' };
  }
  if (!story) {
    return {
      state: 'unknown',
      story_head: null,
      error: "the story doesn't say which commit it was told from (re-render it with once-upon)",
    };
  }
  let head: string;
  try {
    head = await currentHead(meta.repo, meta.number);
  } catch (e) {
    return {
      state: 'unknown',
      story_head: story,
      error: `couldn't read the PR's head with gh: ${(e as Error).message}`,
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
  let cmp: GhCompare;
  try {
    cmp = await cached(`cmp ${meta.repo} ${story} ${head}`, () =>
      ghApiJson<GhCompare>([`repos/${meta.repo}/compare/${story}...${head}`]),
    );
  } catch (e) {
    return {
      state: 'stale',
      story_head: story,
      current_head: head,
      newer: null,
      changed_files: [],
      chapters_touched: [],
      error: `couldn't compare the commits: ${(e as Error).message}`,
    };
  }
  const changed = (cmp.files || []).map((file) => file.filename);
  const set = new Set(changed);
  const touched = chapters
    .map((chapter, i) => ((chapter.files || []).some((file) => set.has(fileOf(file))) ? i + 1 : 0))
    .filter(Boolean);
  return {
    state: 'stale',
    story_head: story,
    current_head: head,
    newer: Number.isFinite(cmp.ahead_by) ? (cmp.ahead_by as number) : (cmp.commits || []).length,
    rewritten: cmp.status === 'diverged' || cmp.status === 'behind', // a force-push or rebase since the story
    changed_files: changed,
    chapters_touched: touched,
  };
}
