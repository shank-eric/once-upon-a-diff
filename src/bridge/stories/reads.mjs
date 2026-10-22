/**
 * What the reviewer has read: one record per chapter, with the commit that was
 * current when they read it. The panel reports a read when they leave a chapter
 * they spent real time on (READ_MIN_SECONDS, counted only while the tab is
 * showing), or when they've marked all its files viewed. A chapter whose files
 * were all Viewed already when the panel opened, with no record here, counts
 * too (reason 'inferred'): they reviewed it before reads were tracked.
 *
 *   <home>/state/<key>/read.json   {<chapter key>: {head_sha, story_head, at, reason, title, step}}
 *
 * <key> is the PR (pr-<owner>-<repo>-<N>, as drafts.json uses), so a
 * re-rendered or regenerated story keeps them, or a local story's id.
 *   head_sha    the PR's head when they read it (from the panel, else gh), or a local story's head commit
 *   story_head  the commit the story was told from at the time; the same as head_sha unless the story was out of date
 *
 * A chapter's key is its `key` in chapters.json, else its title without the
 * "Chapter N:" prefix, so putting a new chapter first doesn't change the
 * others' keys.
 *
 * sinceOf() works out where a story update should start: the story head they
 * read the earliest chapter at, ignoring reads made before they read the newest
 * "Since you read it" chapter (that chapter caught them up), and falling back
 * to the commit the story was told from.
 */
import { stateFile } from '../config/settings.mjs';
import { readJson, writeJson } from '../util/json-file.mjs';
import { chapterKeyOf } from '../../shared/panel/story-model.js';
import { SHA_RE } from '../../shared/util/text.js';

export const READ_MIN_SECONDS = 30;
/** time: they stayed on it; viewed: they ticked its last file; inferred: its files were all Viewed already when the panel opened (a review before read tracking, or with the panel closed) */
export const READ_REASONS = ['time', 'viewed', 'inferred'];

const file = (home, key) => stateFile(home, key, 'read.json');
export function readReads(home, key) {
  const reads = readJson(file(home, key), {});
  return reads && typeof reads === 'object' && !Array.isArray(reads) ? reads : {};
}

/** Record (or refresh) one chapter's read. A later read of the same chapter replaces the earlier one. */
export function noteRead(
  home,
  key,
  chapter,
  {
    head_sha = null,
    story_head = null,
    reason = 'time',
    title = '',
    step = null,
    seconds = null,
  } = {},
) {
  const all = readReads(home, key);
  all[chapter] = {
    head_sha: SHA_RE.test(String(head_sha || '')) ? head_sha : null,
    story_head: SHA_RE.test(String(story_head || '')) ? story_head : null,
    at: new Date().toISOString(),
    reason: READ_REASONS.includes(reason) ? reason : 'time',
    title: String(title || '').slice(0, 300),
    step: Number.isFinite(+step) ? Math.trunc(+step) : null,
    ...(Number.isFinite(+seconds) && seconds !== null ? { seconds: Math.round(+seconds) } : {}),
  };
  writeJson(file(home, key), all);
  return all[chapter];
}

/**
 * Sets aside the reads of these chapter keys, which a rebuild re-told: each moves to "<key> (before the rebuild)", so
 * the chapter counts as unread and the record stays in read.json. Returns how many moved.
 */
export function retireReads(home, key, chapterKeys) {
  const all = readReads(home, key);
  const moving = chapterKeys.filter((chapter) => all[chapter]);
  for (const chapter of moving) {
    all[`${chapter} (before the rebuild)`] = {
      ...all[chapter],
      retired_at: new Date().toISOString(),
    };
    delete all[chapter];
  }
  if (moving.length) {
    writeJson(file(home, key), all);
  }
  return moving.length;
}

/** The commit a read stands for: what the story told them (story_head), else the PR head they saw. */
export const readSha = (read) => (read && (read.story_head || read.head_sha)) || null;

/**
 * Since they read them: the chapters (other than "Since you read it" ones) whose files changed after the commit they
 * read them at, and the drafted comments whose line changed. `changes` is Map(sha -> changesSince(meta, sha)).
 * A comment counts when its line falls in a changed hunk's old side (git's 3 lines of context give some slack),
 * or its file was deleted or renamed.
 * @returns {{changed: {step, chapter, since, files}[], stale_comments: {step, index, path, line, since}[]}}
 */
export function changedSinceRead(chapters, reads, changes, storyHead) {
  const changed = [];
  const stale = [];
  (chapters || []).forEach((chapter, i) => {
    if (chapter.since) {
      return;
    }
    const key = chapter.key || chapterKeyOf(chapter);
    const sha = readSha(reads && reads[key]);
    const diff = sha && sha !== storyHead ? changes.get(sha) : null;
    if (!diff || !diff.size) {
      return;
    }
    const files = (chapter.files || []).map((file) => file.rel).filter((rel) => diff.has(rel));
    if (files.length) {
      changed.push({ step: i + 1, chapter: key, since: sha, files });
    }
    (chapter.comments || []).forEach((comment, index) => {
      const file = comment.path && Number(comment.line) > 0 ? diff.get(comment.path) : null;
      if (!file) {
        return;
      }
      const line = Number(comment.line);
      const hit =
        file.kind === 'deleted' ||
        file.kind === 'renamed' ||
        file.hunks.some(
          (hunk) => line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1),
        );
      if (hit) {
        stale.push({ step: i + 1, index, path: comment.path, line, since: sha });
      }
    });
  });
  return { changed, stale_comments: stale };
}

/**
 * Where an update should start.
 * @param {object} reads read.json
 * @param {{key: string, title: string, since?: object}[]} chapters the story's chapters as stories.load gives them
 * @param {string|null} fallback the commit the story was told from
 * @returns {{since_sha: string|null, source: 'read'|'story'|null, chapter: string|null, at: string|null, read: {chapter, title, sha, at}[]}}
 */
export function sinceOf(reads, chapters, fallback = null) {
  const keys = new Map(
    (chapters || []).map((chapter) => [chapter.key || chapterKeyOf(chapter), chapter]),
  );
  const entries = Object.entries(reads || {})
    .filter(
      ([k, read]) => keys.has(k) && read && readSha(read) && Number.isFinite(Date.parse(read.at)),
    )
    .map(([k, read]) => ({
      chapter: k,
      title: read.title || keys.get(k).title || k,
      sha: readSha(read),
      at: read.at,
      addendum: !!keys.get(k).since,
    }));
  // reading the newest "Since you read it" chapter caught them up to its commit, so older reads don't count
  const cutoff = Math.max(
    0,
    ...entries.filter((read) => read.addendum).map((read) => Date.parse(read.at)),
  );
  const counted = entries
    .filter((read) => Date.parse(read.at) >= cutoff)
    .sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  const list = entries.map(({ addendum, ...rest }) => rest);
  if (counted.length) {
    return {
      since_sha: counted[0].sha,
      source: 'read',
      chapter: counted[0].chapter,
      at: counted[0].at,
      read: list,
    };
  }
  const fallbackSha = SHA_RE.test(String(fallback || '')) ? fallback : null;
  return {
    since_sha: fallbackSha,
    source: fallbackSha ? 'story' : null,
    chapter: null,
    at: null,
    read: list,
  };
}
