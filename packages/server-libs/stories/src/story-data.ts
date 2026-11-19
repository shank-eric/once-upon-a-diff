/*
 * A story as the panel takes it (the overlay's data): its chapters and
 * files, and for a local story the diff and the
 * bridge's state (viewed files, notes).
 */
import { approvalAtTip, readApproval } from './approval.ts';
import path from 'node:path';
import { pathSha } from './diff.ts';
import { readPrefs, type Prefs } from '@once-upon-a-diff/foundation/settings';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { checkedMeta, readMeta, storyVersion, localVersion } from './meta.ts';
import { chaptersOf, addLeftoverChapter, markUnwritten, refOf } from './chapters.ts';
import { movedRefs, readAnchors } from './anchors.ts';
import { thinHunks, uncoveredHunks } from './hunk-coverage.ts';
import {
  loadDiff,
  refreshLocal,
  movedSince,
  diffIgnoringWhitespace,
  localFilesOf,
} from './local-diff.ts';
import type {
  Chapter,
  DiffFile,
  LocalNote,
  StoryData,
  UncoveredFile,
} from '@once-upon-a-diff/contracts/types';
import { skeletonKeys } from './skeleton.ts';
import { isStoryless } from './local-story.ts';
import type { Plan } from './chapters.ts';
import type { LocalMeta, StoryStateReader } from './types.ts';
import { storyParts } from './parts.ts';

/** file-map.json, as once-upon's build writes it: where each file is told, and any hunks it was let publish untold. */
export interface FileMap {
  pr?: string;
  files?: Record<string, { chapters: number[]; partial_in: number[]; finished_in: number | null }>;
  uncovered_hunks?: UncoveredFile[];
  /** how many places the build found told thinly (hunk-coverage.ts thinHunks) */
  thin_hunks?: number;
}

/** The story's files: file-map.json's, else the diff's. */
function relsOf(map: FileMap | null, diff: Map<string, DiffFile> | null): string[] {
  if (map && map.files) {
    return Object.keys(map.files);
  }
  return diff ? [...diff.keys()] : [];
}

/** The story's meta, with a local story's diff brought up to date first; throws when its meta.json is not trusted. */
function trustedMeta(
  store: StoryStateReader,
  id: string,
  dir: string,
): ReturnType<typeof readMeta> {
  const refused = checkedMeta(
    dir,
    readJson<LocalMeta>(path.join(dir, 'meta.json'), null),
    store.home,
  ).problem;
  if (refused) {
    throw new Error(`story ${id} is not served: its meta.json is not trusted (${refused})`);
  }
  const meta = readMeta(dir);
  if (meta.kind !== 'local') {
    return meta;
  }
  refreshLocal(dir, readJson<LocalMeta>(path.join(dir, 'meta.json'), {} as LocalMeta) as LocalMeta);
  return readMeta(dir);
}

/**
 * The plan's chapters and overview refs as the panel draws them. Each leaves its chapters' files out of `rels` when the diff has no such file any more, and adds to `rels`
 * the files the chapters name that it lacks.
 */
function tellChapters(
  dir: string,
  meta: ReturnType<typeof readMeta>,
  plan: Plan,
  diff: Map<string, DiffFile> | null,
  rels: string[],
) {
  const chapters = chaptersOf(plan);
  // a local diff is the truth: a file that has left it (say, reverted) leaves its chapters too
  if (diff) {
    for (const chapter of chapters) {
      chapter.files = chapter.files.filter((file) => diff.has(file.rel));
      chapter.refs = chapter.refs.filter((ref) => diff.has(ref.path));
    }
  }
  const overviewRefs = (plan.refs || []).map(refOf);
  // a local story's refs say when the code at their lines has changed since it was told
  const anchors = meta.kind === 'local' && diff ? readAnchors(dir) : null;
  if (anchors && diff) {
    movedRefs(chapters, overviewRefs, anchors, diff);
  }
  const named = chapters.flatMap((chapter) => chapter.files.map((file) => file.rel));
  rels.push(...new Set(named.filter((rel) => !rels.includes(rel))));
  return { chapters, overviewRefs };
}

/** The hunks no chapter points at and how many are told thinly: counted from a local story's diff, else from what the build wrote in file-map.json. */
function hunkCoverage(
  chapters: Chapter[],
  diff: Map<string, DiffFile> | null,
  map: FileMap | null,
) {
  if (diff) {
    return {
      uncovered: uncoveredHunks(chapters, diff),
      thin: thinHunks(chapters, diff, { linked: true }).length,
    };
  }
  return { uncovered: map?.uncovered_hunks || [], thin: map?.thin_hunks || 0 };
}

/** A chapter first published without its text: Viewed ticks made meanwhile say nothing about it (skeleton.ts). */
function markSkeletons(chapters: Chapter[], dir: string): void {
  const skeleton = skeletonKeys(dir);
  for (const chapter of chapters) {
    if (skeleton.has(chapter.key) && !chapter.auto && !chapter.since) {
      chapter.skeleton = true;
    }
  }
}

/** The local story's own data: its diff and the bridge's state for it (viewed files, notes, approval). */
function localData(
  store: StoryStateReader,
  id: string,
  dir: string,
  meta: ReturnType<typeof readMeta>,
  rels: string[],
  diff: Map<string, DiffFile> | null,
  prefs: Prefs,
): NonNullable<StoryData['local']> {
  const local = meta as LocalMeta & { title: string };
  const viewed = store.readState<Record<string, { hash?: string }>>(id, 'viewed.json', {});
  const shown = prefs.hideWhitespace ? diffIgnoringWhitespace(dir, local) : null;
  const found = approvalAtTip(store, id, local);
  const data: NonNullable<StoryData['local']> = {
    hide_whitespace: !!shown,
    diff_view: prefs.diffView,
    repo: local.repo_path,
    base: local.base,
    head: local.head,
    base_oid: local.base_oid as string | null,
    head_oid: local.head_oid as string | null,
    branch: local.branch || null,
    commits: local.commits || [],
    files: localFilesOf(rels, diff, shown, viewed as Record<string, { hash?: string }>),
    notes: store.readState<LocalNote[]>(id, 'notes.json', []) as LocalNote[],
    approved: found ? { at: found.at, head_oid: found.head_oid } : null,
    moved: movedSince(local),
    storyless: isStoryless(dir),
  };
  // why an approval lapsed, while the story has none that counts
  const lapsed = data.approved ? null : readApproval(store, id);
  if (lapsed?.lapsed && lapsed.lapse) {
    data.lapse = lapsed.lapse;
  }
  return data;
}

/** The PR a story is of, as the panel shows it (nulls for a local story). */
const prOf = (meta: ReturnType<typeof readMeta>): StoryData['pr'] => ({
  repo: meta.repo || null,
  number: meta.number || null,
  title: meta.pr_title || meta.title,
  url: meta.url || null,
});

export function storyData(store: StoryStateReader, id: string, dir: string): StoryData {
  const meta = trustedMeta(store, id, dir);
  const plan = readJson<Plan>(path.join(dir, 'chapters.json'), {}) || {};
  const diff = loadDiff(dir, meta);
  const map = readJson<FileMap>(path.join(dir, 'file-map.json'), null);
  const rels = relsOf(map, diff);
  const { chapters, overviewRefs } = tellChapters(dir, meta, plan, diff, rels);
  // hunks no chapter points at: a build allowed to publish with them says so in file-map.json, a local story's diff is here
  const { uncovered, thin } = hunkCoverage(chapters, diff, map);
  addLeftoverChapter(chapters, rels);
  markUnwritten(chapters, plan);
  markSkeletons(chapters, dir);
  const prefs = meta.kind === 'local' ? readPrefs(store.home) : null;
  const data: StoryData = {
    id,
    kind: meta.kind,
    version: prefs ? localVersion(dir, prefs, movedSince(meta as LocalMeta)) : storyVersion(dir),
    pr: prOf(meta),
    title: meta.title,
    overview: plan.overview || '',
    summary: plan.summary || '',
    plan: plan.plan || '',
    overview_refs: overviewRefs,
    files: rels.map((rel) => ({ rel, sha: pathSha(rel) })),
    chapters,
    uncovered_hunks: uncovered,
    ...(thin ? { thin_hunks: thin } : {}),
  };
  // last, so a file that left a local diff and the "Not in a chapter yet" chapter are counted as the panel shows them
  const parts = storyParts(
    store.home,
    meta,
    chapters.map((chapter) => chapter.files.map((file) => file.rel)),
    rels,
  );
  if (parts) {
    data.parts = parts;
  }
  if (prefs) {
    data.local = localData(store, id, dir, meta, rels, diff, prefs);
  }
  return data;
}
