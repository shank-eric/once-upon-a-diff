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
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './util/json-file.mjs';

export const READ_MIN_SECONDS = 30;
/** time: they stayed on it; viewed: they ticked its last file; inferred: its files were all Viewed already when the panel opened (a review before read tracking, or with the panel closed) */
export const READ_REASONS = ['time', 'viewed', 'inferred'];
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A chapter's stable key: its own `key`, else its title without "Chapter N:", lowercased. */
export function chapterKey(ch) {
  if (ch && typeof ch.key === 'string' && ch.key.trim()) {
    return ch.key.trim().slice(0, 200);
  }
  return String((ch && ch.title) || '')
    .replace(/^\s*chapter\s+\d+\s*[:.–—-]\s*/i, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function file(home, key) {
  const dir = path.join(home, 'state', key);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'read.json');
}
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

/** The commit a read stands for: what the story told them (story_head), else the PR head they saw. */
export const readSha = (r) => (r && (r.story_head || r.head_sha)) || null;

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
  (chapters || []).forEach((ch, i) => {
    if (ch.since) {
      return;
    }
    const key = ch.key || chapterKey(ch);
    const sha = readSha(reads && reads[key]);
    const diff = sha && sha !== storyHead ? changes.get(sha) : null;
    if (!diff || !diff.size) {
      return;
    }
    const files = (ch.files || []).map((f) => f.rel).filter((rel) => diff.has(rel));
    if (files.length) {
      changed.push({ step: i + 1, chapter: key, since: sha, files });
    }
    (ch.comments || []).forEach((c, index) => {
      const f = c.path && Number(c.line) > 0 ? diff.get(c.path) : null;
      if (!f) {
        return;
      }
      const line = Number(c.line);
      const hit =
        f.kind === 'deleted' ||
        f.kind === 'renamed' ||
        f.hunks.some((h) => line >= h.oldStart && line < h.oldStart + Math.max(h.oldLines, 1));
      if (hit) {
        stale.push({ step: i + 1, index, path: c.path, line, since: sha });
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
  const keys = new Map((chapters || []).map((ch) => [ch.key || chapterKey(ch), ch]));
  const read = Object.entries(reads || {})
    .filter(([k, r]) => keys.has(k) && r && readSha(r) && Number.isFinite(Date.parse(r.at)))
    .map(([k, r]) => ({
      chapter: k,
      title: r.title || keys.get(k).title || k,
      sha: readSha(r),
      at: r.at,
      addendum: !!keys.get(k).since,
    }));
  // reading the newest "Since you read it" chapter caught them up to its commit, so older reads don't count
  const cutoff = Math.max(0, ...read.filter((r) => r.addendum).map((r) => Date.parse(r.at)));
  const counted = read
    .filter((r) => Date.parse(r.at) >= cutoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const list = read.map(({ addendum, ...r }) => r);
  if (counted.length) {
    return {
      since_sha: counted[0].sha,
      source: 'read',
      chapter: counted[0].chapter,
      at: counted[0].at,
      read: list,
    };
  }
  const fb = SHA_RE.test(String(fallback || '')) ? fallback : null;
  return { since_sha: fb, source: fb ? 'story' : null, chapter: null, at: null, read: list };
}
