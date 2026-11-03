/*
 * A story as the panel takes it (the overlay's data): its chapters and
 * files, and for a local story the diff and the
 * bridge's state (viewed files, notes).
 */
import { approvalOf } from '../review/approve.ts';
import { shipMode } from './push-default.ts';
import path from 'node:path';
import { pathSha } from './diff.ts';
import { readPrefs } from '../config/settings.ts';
import { readJson } from '../../adapters/stores/json-file.ts';
import { readMeta, storyVersion, localVersion } from './meta.ts';
import { chaptersOf, addLeftoverChapter, markUnwritten } from './chapters.ts';
import { upgradePlan } from './legacy.ts';
import { uncoveredHunks } from './hunk-coverage.ts';
import {
  loadDiff,
  refreshLocal,
  movedSince,
  diffIgnoringWhitespace,
  localFilesOf,
} from './local-diff.ts';
import type {
  DiffFile,
  LocalNote,
  StoryData,
  UncoveredFile,
} from '@once-upon-a-diff/protocol/types';
import type { StoryStore } from './store.ts';
import { skeletonKeys } from './skeleton.ts';
import type { Plan } from './chapters.ts';
import type { LocalMeta } from './types.ts';

/** file-map.json, as once-upon's build writes it: where each file is told, and any hunks it was let publish untold. */
export interface FileMap {
  pr?: string;
  files?: Record<string, { chapters: number[]; partial_in: number[]; finished_in: number | null }>;
  uncovered_hunks?: UncoveredFile[];
}

/** The story's files: file-map.json's, else the diff's. */
function relsOf(map: FileMap | null, diff: Map<string, DiffFile> | null): string[] {
  if (map && map.files) {
    return Object.keys(map.files);
  }
  return diff ? [...diff.keys()] : [];
}

export function storyData(store: StoryStore, id: string, dir: string): StoryData {
  let meta = readMeta(dir);
  if (meta.kind === 'local') {
    refreshLocal(
      dir,
      readJson<LocalMeta>(path.join(dir, 'meta.json'), {} as LocalMeta) as LocalMeta,
    );
    meta = readMeta(dir);
  }
  const plan = readJson<Plan>(path.join(dir, 'chapters.json'), {}) || {};
  const diff = loadDiff(dir, meta);
  const map = readJson<FileMap>(path.join(dir, 'file-map.json'), null);
  const rels = relsOf(map, diff);
  // a story told before refs is read as one that has them (legacy.ts); the files on disk stay as they were
  const chapters = chaptersOf(upgradePlan(plan, rels));
  // a local diff is the truth: a file that has left it (say, reverted) leaves its chapters too
  if (diff) {
    for (const chapter of chapters) {
      chapter.files = chapter.files.filter((file) => diff.has(file.rel));
      chapter.refs = chapter.refs.filter((ref) => diff.has(ref.path));
    }
  }
  for (const chapter of chapters) {
    for (const file of chapter.files) {
      if (!rels.includes(file.rel)) {
        rels.push(file.rel);
      }
    }
  }
  // hunks no chapter points at: a build allowed to publish with them says so in file-map.json, a local story's diff is here
  const uncovered = diff ? uncoveredHunks(chapters, diff) : (map && map.uncovered_hunks) || [];
  addLeftoverChapter(chapters, rels);
  markUnwritten(chapters, plan);
  // a chapter first published without its text: Viewed ticks made meanwhile say nothing about it (skeleton.ts)
  const skeleton = skeletonKeys(dir);
  for (const chapter of chapters) {
    if (skeleton.has(chapter.key) && !chapter.auto && !chapter.since) {
      chapter.skeleton = true;
    }
  }
  const prefs = meta.kind === 'local' ? readPrefs(store.home) : null;
  const data: StoryData = {
    id,
    kind: meta.kind,
    version:
      meta.kind === 'local'
        ? localVersion(dir, prefs, movedSince(meta as LocalMeta))
        : storyVersion(dir),
    pr: {
      repo: meta.repo || null,
      number: meta.number || null,
      title: meta.pr_title || meta.title,
      url: meta.url || null,
    },
    title: meta.title,
    overview: plan.overview || '',
    summary: plan.summary || '',
    plan: plan.plan || '',
    files: rels.map((rel) => ({ rel, sha: pathSha(rel) })),
    chapters,
    uncovered_hunks: uncovered,
  };
  if (meta.kind === 'local') {
    const local = meta as LocalMeta & { title: string };
    const viewed = store.readState<Record<string, { hash?: string }>>(id, 'viewed.json', {});
    const shown = prefs!.hideWhitespace ? diffIgnoringWhitespace(dir, local) : null; // a local story has its prefs
    data.local = {
      hide_whitespace: !!shown,
      diff_view: prefs!.diffView,
      repo: local.repo_path,
      base: local.base,
      head: local.head,
      base_oid: local.base_oid as string | null,
      head_oid: local.head_oid as string | null,
      branch: local.branch || null,
      commits: local.commits || [],
      files: localFilesOf(rels, diff, shown, viewed as Record<string, { hash?: string }>),
      notes: store.readState<LocalNote[]>(id, 'notes.json', []) as LocalNote[],
      approved: (() => {
        const found = approvalOf(store, id, local.head_oid);
        return found ? { at: found.at, head_oid: found.head_oid } : null;
      })(),
      moved: movedSince(local),
      ship: shipMode(local, store.home),
    };
  }
  return data;
}
