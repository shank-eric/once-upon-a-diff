/*
 * A story as the panel takes it (the overlay's data): its chapters and
 * files, the story-level backstory, and for a local story the diff and the
 * bridge's state (viewed files, notes).
 */
import path from 'node:path';
import { pathSha } from '../util/diff.mjs';
import { readPrefs } from '../config/settings.mjs';
import { readJson } from '../util/json-file.mjs';
import { readMeta, storyVersion, localVersion } from './meta.mjs';
import { chaptersOf, addLeftoverChapter } from './chapters.mjs';
import { storyBackstory } from './backstory-notes.mjs';
import { addTextRefs } from './text-refs.mjs';
import { loadDiff, refreshLocal, diffIgnoringWhitespace, localFilesOf } from './local-diff.mjs';

/** The story's files: file-map.json's, else the diff's. */
function relsOf(map, diff) {
  if (map && map.files) {
    return Object.keys(map.files);
  }
  return diff ? [...diff.keys()] : [];
}

/** @param {import('./store.mjs').StoryStore} store */
export function storyData(store, id, dir) {
  let meta = readMeta(dir);
  if (meta.kind === 'local') {
    refreshLocal(dir, readJson(path.join(dir, 'meta.json'), {}));
    meta = readMeta(dir);
  }
  const plan = readJson(path.join(dir, 'chapters.json'), {}) || {};
  const diff = loadDiff(dir, meta);
  const rels = relsOf(readJson(path.join(dir, 'file-map.json'), null), diff);
  const chapters = chaptersOf(plan);
  // a local diff is the truth: a file that has left it (say, reverted) leaves its chapters too
  if (diff) {
    for (const chapter of chapters) {
      chapter.files = chapter.files.filter((file) => diff.has(file.rel));
    }
  }
  for (const chapter of chapters) {
    for (const file of chapter.files) {
      if (!rels.includes(file.rel)) {
        rels.push(file.rel);
      }
    }
  }
  // a chapter whose text points at a file's lines tells that file too, so the last one to do it finishes it (text-refs.mjs)
  addTextRefs(chapters, rels);
  addLeftoverChapter(chapters, rels);
  const prefs = meta.kind === 'local' ? readPrefs(store.home) : null;
  const data = {
    id,
    kind: meta.kind,
    version: meta.kind === 'local' ? localVersion(dir, prefs) : storyVersion(dir),
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
    backstory: storyBackstory(plan.backstory, readJson(path.join(dir, 'backstory.json'), null)),
  };
  if (meta.kind === 'local') {
    const viewed = store.readState(id, 'viewed.json', {});
    const shown = prefs.hideWhitespace ? diffIgnoringWhitespace(dir, meta) : null;
    data.local = {
      hide_whitespace: !!shown,
      diff_view: prefs.diffView,
      repo: meta.repo_path,
      base: meta.base,
      head: meta.head,
      base_oid: meta.base_oid,
      head_oid: meta.head_oid,
      branch: meta.branch || null,
      commits: meta.commits || [],
      files: localFilesOf(rels, diff, shown, viewed),
      notes: store.readState(id, 'notes.json', []),
    };
  }
  return data;
}
