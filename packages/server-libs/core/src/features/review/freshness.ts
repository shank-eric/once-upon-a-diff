/**
 * Is a PR story up to date with the PR's latest commit? The story's meta
 * says which head it was told from (once-upon's pr.json headRefOid). The
 * bridge reads the PR's current head and, when it differs, what changed
 * between the two, with read-only `gh api` GETs cached for 60s:
 *   repos/{o}/{r}/pulls/{n}                       head.sha
 *   repos/{o}/{r}/compare/{story head}...{head}   commits and files since
 */
import { commitOf, commitsBetween, diffText, isAncestor } from '@once-upon-a-diff/adapters/git';
import { contentHash, parseHunkHeader, parseUnifiedDiff } from '@once-upon-a-diff/stories/diff';
import { movedSince } from '@once-upon-a-diff/stories/local-diff';
import { ghApiJson } from '@once-upon-a-diff/foundation/gh';
import { prKey } from '@once-upon-a-diff/terms/ids';
import { SHA_RE, sameSha, shortSha } from '@once-upon-a-diff/terms/text';
import type { DiffFile, FreshUpdate, Freshness } from '@once-upon-a-diff/contracts/types';
import type { Build } from '@once-upon-a-diff/state/queues/requests/builds';
import type { PlanFile } from '@once-upon-a-diff/stories/chapters';
import type { StoryMeta } from '@once-upon-a-diff/stories/types';

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
  String(patch || '')
    .split(/\r?\n/)
    .flatMap((line) => {
      const hunk = parseHunkHeader(line);
      return hunk ? [{ oldStart: hunk.oldStart, oldLines: hunk.oldLines }] : [];
    });
const KIND: Record<string, DiffFile['kind']> = {
  added: 'created',
  removed: 'deleted',
  renamed: 'renamed',
};

/** A local story's range: the commits its diff is between (base is the merge-base), as it was or as it is. */
interface Range {
  base: string;
  head: string;
}

/** Each file of a range's diff, by its path, with what its change says (diff.ts contentHash). */
const contentsOf = (repo: string, range: Range): Map<string, string> =>
  new Map(
    [...parseUnifiedDiff(diffText(repo, range.base, range.head)).values()].map((file) => [
      file.rel,
      contentHash(file),
    ]),
  );

/**
 * What a local story's diff changed between two of its ranges: the files in only one of them or whose change differs
 * (the +/- lines, so a patch re-applied onto a moved base, or a new message on the same patch, changes nothing).
 * Not the commit graph: an amend, a rebase and a plain new commit are all just two ranges. Each file is keyed by its path
 * now, with its kind and, from `git diff then.head now.head`, its hunks (approximate when the base moved too). A landed
 * story (its base is its head: nothing of its own left) has no changes. Throws when git can't read a commit.
 */
export function localChanges(repo: string, then: Range, now: Range): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  if (now.base === now.head) {
    return out;
  }
  for (const [what, sha] of [
    ['story', then.head],
    ['base', then.base],
  ] as const) {
    if (!commitOf(repo, sha)) {
      throw new Error(`git doesn't have the ${what} commit ${shortSha(sha)} any more`);
    }
  }
  const before = contentsOf(repo, then);
  const after = contentsOf(repo, now);
  const changed = new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      (rel) => before.get(rel) !== after.get(rel),
    ),
  );
  if (!changed.size) {
    return out;
  }
  const hunks = parseUnifiedDiff(diffText(repo, then.head, now.head));
  // a file renamed since is gone from the new range: its old path finds the renamed entry, so a comment on it is flagged
  const renamed = new Map(
    [...hunks.values()].flatMap((file) => (file.renamed_from ? [[file.renamed_from, file]] : [])),
  );
  for (const rel of changed) {
    const file = hunks.get(rel) || renamed.get(rel);
    out.set(rel, {
      kind: file ? file.kind : 'modified',
      hunks: (file?.hunks || []).map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
      })),
    });
  }
  return out;
}

/**
 * Where a local story's branch is now: the commits freshness, `since` and the read marks all measure against. A story
 * that follows HEAD is at its own range (refreshLocal keeps it current); a pinned one stays at the range it was told over,
 * so the tips its refs have now (movedSince) are what count.
 */
export function liveRange(meta: StoryMeta): { base: string | null; head: string | null } {
  const moved = movedSince(meta as Parameters<typeof movedSince>[0]);
  return {
    base: moved?.base_oid || meta.base_oid || null,
    head: moved?.head_oid || meta.head_oid || null,
  };
}

/**
 * What changed from `sha` to the story's head: Map(path -> {kind, hunks: [{oldStart, oldLines}]}).
 * A PR story asks gh's compare (read-only, cached 60s); a local story asks git (localChanges), `thenBase` being the base
 * the read at `sha` had (the story's told base, else its base, when the read didn't keep one). Throws when it can't tell.
 */
export async function changesSince(
  meta: StoryMeta,
  sha: string | null,
  thenBase: string | null = null,
): Promise<Map<string, FileChange>> {
  const out = new Map<string, FileChange>();
  const live =
    meta.kind === 'local' ? liveRange(meta) : { base: meta.base_oid, head: meta.head_oid };
  if (!sha || !live.head || sha === live.head) {
    return out;
  }
  if (meta.kind === 'local') {
    return localChanges(
      meta.repo_path as string,
      { base: thenBase || meta.told_base_oid || live.base || sha, head: sha },
      { base: live.base || sha, head: live.head },
    );
  }
  const cmp = await cached(`cmp ${meta.repo} ${sha} ${meta.head_oid}`, () =>
    ghApiJson<GhCompare>(`repos/${meta.repo}/compare/${sha}...${meta.head_oid}`),
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
    ghApiJson<GhCompare>(`repos/${repo}/compare/${from}...${toSha}`),
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
      (await ghApiJson<{ head: { sha: string } }>(`repos/${repo}/pulls/${Number(number)}`)).head
        .sha,
  );

const fileOf = (file: PlanFile) => (typeof file === 'string' ? file : file.rel);

/** The chapters (1-based) that list one of these files. */
const touchedBy = (chapters: ChapterFiles[], files: Set<string>) =>
  chapters
    .map((chapter, i) =>
      (chapter.files || []).some((file) => files.has(fileOf(file))) ? i + 1 : 0,
    )
    .filter(Boolean);

/**
 * A local story is stale when its diff now says something the chapters were not told over (told_head_oid, told_base_oid):
 * a new commit, an amend, a rebase that changed a patch. A new message, or the same patch on a moved main, is current, and so
 * is a story that landed in its base (its diff is empty, so every told file would read as changed). A pinned story is
 * measured against where its branch is now (movedSince). 'n/a' for a story with no told plan, 'unknown' when git can't
 * read the commits it was told over.
 */
function localFreshness(meta: StoryMeta, chapters: ChapterFiles[]): Freshness {
  const told = meta.told_head_oid;
  const repo = meta.repo_path;
  if (!told || !repo) {
    return { state: 'n/a' };
  }
  const { head, base } = liveRange(meta);
  const known = { story_head: told, current_head: head || null, local: true };
  if (!head || !base) {
    return { state: 'unknown', ...known, error: "the story's commits are not known" };
  }
  const current = {
    state: 'current' as const,
    ...known,
    newer: 0,
    changed_files: [],
    chapters_touched: [],
  };
  const toldBase = meta.told_base_oid || base;
  if ((told === head && toldBase === base) || base === head) {
    return current;
  }
  let changes: Map<string, FileChange>;
  try {
    changes = localChanges(repo, { base: toldBase, head: told }, { base, head });
  } catch (e) {
    return {
      state: 'unknown',
      ...known,
      error: `couldn't compare with the commit the story was told over: ${(e as Error).message}`,
    };
  }
  if (!changes.size) {
    return current;
  }
  const rewritten = !isAncestor(repo, told, head);
  const files = new Set(changes.keys());
  return {
    state: 'stale',
    ...known,
    newer: rewritten ? null : commitsBetween(repo, told, head).length,
    rewritten,
    changed_files: [...files],
    chapters_touched: touchedBy(chapters, files),
  };
}

/** Whether the build is a finished update from a commit other than the story's head: the kind `updatedInPlace` can compare. */
export function isFinishedUpdateFrom(build: Build | null, story: string): build is Build {
  if (!build) {
    return false;
  }
  const isFinishedUpdate = build.status === 'done' && build.mode === 'update';
  const hasBaseSha = SHA_RE.test(String(build.base_sha || ''));
  const startsElsewhere = !sameSha(build.base_sha, story);
  return isFinishedUpdate && hasBaseSha && startsElsewhere;
}

/**
 * An update that rewrote the story in place, with no "Since you read it" chapter for it: the last build for the PR was
 * a finished update from an older commit, and no chapter covers that range. Then the panel can still say what's new,
 * from GitHub's compare of the old head with the story's. Null when there's nothing to say or gh can't tell.
 */
async function updatedInPlace(
  meta: StoryMeta,
  chapters: ChapterFiles[],
  lastBuild: Build | null,
): Promise<FreshUpdate | null> {
  const build = lastBuild;
  const story = meta.head_oid;
  if (!story || !isFinishedUpdateFrom(build, story)) {
    return null;
  }
  if (chapters.some((chapter) => chapter.since && sameSha(chapter.since.to, story))) {
    return null;
  } // a "Since you read it" chapter tells it
  let cmp: GhCompare;
  try {
    cmp = await cached(`cmp ${meta.repo} ${build.base_sha} ${story}`, () =>
      ghApiJson<GhCompare>(`repos/${meta.repo}/compare/${build.base_sha}...${story}`),
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
  if (meta.kind === 'local') {
    return localFreshness(meta, chapters);
  }
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
      ghApiJson<GhCompare>(`repos/${meta.repo}/compare/${story}...${head}`),
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
