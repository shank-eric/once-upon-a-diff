/**
 * Local mode: a story over a local commit range instead of a GitHub PR. The
 * story lives in the checkout (or worktree) it diffs, at <top>/.once-upon/<id>/,
 * kept out of git by .git/info/exclude (placement.ts). The folder holds meta.json (repo, refs), local.diff (remade whenever the
 * refs move) and chapters.json in once-upon's format, so the same panel and
 * the same chapters work on either.
 */
import { existsSync, readFileSync } from 'node:fs';
import { copyFileAtomic, readJson, writeJsonAtomic } from '../../adapters/stores/fs/json-file.ts';
import path from 'node:path';
import { FULL_SHA_RE } from '@once-upon-a-diff/protocol/domain/patterns';
import { topLevel, revParse, branchOfRef, mergeBase } from '../../adapters/git.ts';
import { defaultBranchOf } from './push-default.ts';
import { removeFile } from '../../adapters/stores/fs/files.ts';
import { parseUnifiedDiff } from './diff.ts';
import { refreshLocal, followsHead } from './local-diff.ts';
import { entryOf } from './chapters.ts';
import { ID_RE } from './meta.ts';
import { storyDirFor } from './placement.ts';
import { repoOfCheckout, seenCheckout } from '../config/repos.ts';
import { plural } from '@once-upon-a-diff/protocol/domain/text';
import type { DiffFile } from '@once-upon-a-diff/protocol/types';
import { noteSkeleton } from './skeleton.ts';
import { readyPlan } from './validate.ts';
import type { LocalMeta, StoryMeta } from './types.ts';
import type { Plan, PlanChapter } from './chapters.ts';

/** What vet sees: the story, its diff, and the chapters before and after. */
export interface VetInput {
  id: string;
  meta: StoryMeta;
  diff: Map<string, DiffFile>;
  before: Plan;
  after: Plan;
}

export const slug = (text: string): string =>
  String(text)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

const WORKSPACE_FOLDERS = ['apps', 'libs', 'packages', 'tools', 'services'];
/** A file's group: its package in a monorepo (apps/x), else its top-level folder, else (root). */
function groupOf(rel: string): string {
  const parts = rel.split('/');
  if (parts.length > 2 && WORKSPACE_FOLDERS.includes(parts[0])) {
    return parts.slice(0, 2).join('/');
  }
  return parts.length > 1 ? parts[0] : '(root)';
}

const BY_FOLDER = 'by-folder';
/**
 * Written by Review (reviewBranch) only, next to the story's chapters.json, with the sha it pinned the story to: this
 * story is a storyless review while it is still pinned there.
 */
const STORYLESS_FILE = 'storyless.json';

/** Whether a plan is the by-folder fallback with no chapter told. */
const untold = (plan: Plan | null): boolean =>
  plan?.mode === BY_FOLDER &&
  !(plan.chapters || []).some((chapter) => String(chapter.narrative || '').trim());

/**
 * Whether the story served from `dir` is a storyless review (no Approve: Push or Create pull request is the approval).
 * Only Review marks one, and the mark counts only while the story is still pinned to the sha Review pinned it to (a
 * branch's name, not HEAD) and is the by-folder fallback with no chapter told. Chapters published over it clear the mark
 * (createLocalStory), and a mark left from an older Review (a reused branch name, a story made again by hand) is ignored.
 */
export function isStoryless(dir: string): boolean {
  const mark = readJson<{ head_oid?: unknown }>(path.join(dir, STORYLESS_FILE), null);
  const meta = readJson<Partial<LocalMeta>>(path.join(dir, 'meta.json'), null);
  return (
    !!mark &&
    !!meta &&
    typeof mark.head_oid === 'string' &&
    mark.head_oid === meta.head_oid &&
    typeof meta.head === 'string' &&
    !followsHead({ head: meta.head }) &&
    untold(readJson<Plan>(path.join(dir, 'chapters.json'), null))
  );
}

/** One chapter per top-level folder: a starting point until a real story is written. */
export function defaultChapters(rels: string[], title: string | undefined) {
  const groups = new Map<string, string[]>();
  for (const rel of rels) {
    const key = groupOf(rel);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(rel);
  }
  const chapters = [...groups].map(([key, files], i) => ({
    title: `Chapter ${i + 1}: ${key}`,
    summary: `${plural(files.length, 'file')} under ${key}.`,
    narrative: '',
    files,
  }));
  return {
    mode: BY_FOLDER,
    title,
    overview: `No story has been told for these commits, so this is the diff by folder. Build story on the board tells one; Create pull request or Push here needs no Approve.`,
    chapters,
  };
}

/**
 * Makes or refreshes a local story. `vet({id, meta, diff, before, after})`, when given, sees the new chapters (from
 * `chapters`) and the ones they replace before they're written: it throws to refuse them, or returns the chapters to
 * write instead (null writes them as they are). The written chapters go back to `chapters` too, so a later run keeps them.
 */
export function createLocalStory({
  home,
  repo,
  base,
  head = 'HEAD',
  chapters,
  id,
  title,
  vet = null,
}: {
  home: string;
  repo: string;
  base: string;
  head?: string;
  chapters?: string | null;
  id?: string | null;
  title?: string | null;
  vet?: ((input: VetInput) => Plan | null) | null;
}) {
  const top = topLevel(repo);
  revParse(top, base); // fail early on a bad ref
  revParse(top, head);
  // the branch --head names (the checkout's only when it is HEAD), so Create pull request pushes the story's branch
  const { branch, ambiguous } = branchOfRef(top, head);
  const name = path.basename(top);
  // the story is told by the branch only when --head names it (or is HEAD): a commit stays its own story, by its first
  // nine characters when it is a full sha, so it never takes over the default story of the branch it happens to tip
  const named = head === 'HEAD' || head.replace(/^refs\/heads\//, '') === branch;
  const shown = (named && branch) || (FULL_SHA_RE.test(head) ? head.slice(0, 9) : head);
  id = id || slug(`local-${name}-${shown}`);
  if (!ID_RE.test(id)) {
    throw new Error(`bad story id: ${id}`);
  }
  const dir = storyDirFor(home, id, { checkout: top });
  const origin = repoOfCheckout(top);
  if (origin) {
    seenCheckout(home, origin, top);
  }
  const metaFile = path.join(dir, 'meta.json');
  const old: Partial<StoryMeta> = existsSync(metaFile)
    ? JSON.parse(readFileSync(metaFile, 'utf8'))
    : {};
  // a story over HEAD keeps its commits when told again (refreshLocal follows the checkout). A pinned one is told again to
  // take the tips as they are now, so its stored commits are dropped and refreshLocal pins the new ones.
  const sameRange =
    old.repo_path === top && old.base === base && old.head === head && followsHead({ head });
  const meta: LocalMeta = {
    kind: 'local',
    repo_path: top,
    repo_name: name,
    base,
    head,
    branch,
    base_oid: sameRange ? old.base_oid : null,
    head_oid: sameRange ? old.head_oid : null, // null makes the diff get remade
    built_at: new Date().toISOString(), // a publish or a rebuild: refreshLocal keeps it, so a moved HEAD is not one
    title:
      title ||
      (old.title as string | undefined) ||
      `${name}: ${base}..${shown}${branch ? ` (${branch})` : ''}`,
  };
  writeJsonAtomic(metaFile, meta);
  refreshLocal(dir, meta);

  const diff = parseUnifiedDiff(readFileSync(path.join(dir, 'local.diff'), 'utf8'));
  const rels = [...diff.keys()];
  const chaptersFile = path.join(dir, 'chapters.json');
  if (chapters) {
    removeFile(path.join(dir, STORYLESS_FILE)); // told: a story now, with Approve before Push
    const after: Plan = JSON.parse(readFileSync(path.resolve(chapters), 'utf8'));
    // chapters handed in are a told story: a by-folder mode carried over from the fallback (a rebuild starting from the
    // served chapters.json) would skip the being-written check, so it is dropped
    const carried = after.mode === BY_FOLDER;
    if (carried) {
      delete after.mode;
    }
    const before: Plan = existsSync(chaptersFile)
      ? JSON.parse(readFileSync(chaptersFile, 'utf8'))
      : {};
    const vetted = vet ? vet({ id, meta, diff, before, after }) : null;
    // every chapter has a key and its refs (validate.ts); an older story's chapters kept as they were are let through
    const ready = vetted || after;
    const assigned = readyPlan(ready, { diff, served: before });
    if (vetted || assigned.length || carried) {
      writeJsonAtomic(chaptersFile, ready);
      writeJsonAtomic(path.resolve(chapters), ready);
    } else {
      copyFileAtomic(path.resolve(chapters), chaptersFile);
    }
  }
  if (!existsSync(chaptersFile)) {
    writeJsonAtomic(chaptersFile, defaultChapters(rels, meta.title));
  }

  const plan: Plan = JSON.parse(readFileSync(chaptersFile, 'utf8'));
  noteSkeleton(dir, plan);
  const placed = new Set(
    (plan.chapters || []).flatMap((chapter: PlanChapter) =>
      (chapter.files || []).map((e) => entryOf(e).rel),
    ),
  );
  return {
    id,
    dir,
    files: rels.length,
    chapters: (plan.chapters || []).length,
    unplaced: rels.filter((rel) => !placed.has(rel)),
    unknown: [...placed].filter((rel) => !diff.has(rel)),
    ambiguous,
  };
}

/**
 * A storyless review of a branch (the board's Review): a by-folder local story over the commits the branch has beyond
 * origin's default branch (else the local main or master), so the page has its diff, Create pull request and Push. The base
 * is their merge-base as a sha, since the diff is two-dot and a default branch that moved on would show its commits
 * undone; the head is the branch's name, so the story records the branch. Told again, it refreshes the same story.
 */
export function reviewBranch({
  home,
  path: dir,
  branch,
}: {
  home: string;
  path: string;
  branch: string;
}) {
  const top = topLevel(dir);
  const remote = defaultBranchOf(top);
  const target = remote
    ? `refs/remotes/origin/${remote}`
    : ['main', 'master'].map((name) => `refs/heads/${name}`).find((ref) => hasRef(top, ref));
  if (!target) {
    throw new Error('no default branch to compare the branch with');
  }
  const base = mergeBase(top, target, `refs/heads/${branch}`);
  if (base === revParse(top, `refs/heads/${branch}`)) {
    throw new Error(`${branch} has no commits of its own to review`);
  }
  const made = createLocalStory({ home, repo: top, base, head: branch });
  // a story already told under this id stays a story; else the mark names the sha it is pinned to now
  const pinned = readJson<Partial<LocalMeta>>(path.join(made.dir, 'meta.json'), null)?.head_oid;
  if (pinned && untold(readJson<Plan>(path.join(made.dir, 'chapters.json'), null))) {
    writeJsonAtomic(path.join(made.dir, STORYLESS_FILE), {
      at: new Date().toISOString(),
      head_oid: pinned,
    });
  }
  return made;
}

function hasRef(repo: string, ref: string): boolean {
  try {
    return !!revParse(repo, ref);
  } catch {
    return false;
  }
}
