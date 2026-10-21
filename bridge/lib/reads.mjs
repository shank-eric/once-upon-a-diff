/**
 * What Eric has read: one record per chapter, with the commit that was
 * current when he read it. The panel reports a read when he leaves a chapter
 * he spent real time on (READ_MIN_SECONDS, counted only while the tab is
 * showing), or when he has marked all its files viewed.
 *
 *   <home>/state/<key>/read.json   {<chapter key>: {head_sha, story_head, at, reason, title, step}}
 *
 * <key> is the PR (pr-<owner>-<repo>-<N>, as drafts.json uses), so a
 * re-rendered or regenerated story keeps them, or a local story's id.
 *   head_sha    the PR's head when he read it (from the panel, else gh), or a local story's head commit
 *   story_head  the commit the story was told from at the time; the same as head_sha unless the story was out of date
 *
 * A chapter's key is its `key` in chapters.json, else its title without the
 * "Chapter N:" prefix, so putting a new chapter first doesn't change the
 * others' keys.
 *
 * sinceOf() works out where a story update should start: the story head he
 * read the earliest chapter at, ignoring reads made before he read the newest
 * "Since you read it" chapter (that chapter caught him up), and falling back
 * to the commit the story was told from.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const READ_MIN_SECONDS = 30;
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A chapter's stable key: its own `key`, else its title without "Chapter N:", lowercased. */
export function chapterKey(ch) {
  if (ch && typeof ch.key === 'string' && ch.key.trim()) return ch.key.trim().slice(0, 200);
  return String((ch && ch.title) || '').replace(/^\s*chapter\s+\d+\s*[:.–—-]\s*/i, '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

function file(home, key) {
  const dir = path.join(home, 'state', key);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'read.json');
}
export function readReads(home, key) {
  try { const v = JSON.parse(readFileSync(file(home, key), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** Record (or refresh) one chapter's read. A later read of the same chapter replaces the earlier one. */
export function noteRead(home, key, chapter, { head_sha = null, story_head = null, reason = 'time', title = '', step = null, seconds = null } = {}) {
  const all = readReads(home, key);
  all[chapter] = {
    head_sha: SHA_RE.test(String(head_sha || '')) ? head_sha : null,
    story_head: SHA_RE.test(String(story_head || '')) ? story_head : null,
    at: new Date().toISOString(),
    reason: reason === 'viewed' ? 'viewed' : 'time',
    title: String(title || '').slice(0, 300),
    step: Number.isFinite(+step) ? Math.trunc(+step) : null,
    ...(Number.isFinite(+seconds) && seconds !== null ? { seconds: Math.round(+seconds) } : {}),
  };
  writeFileSync(file(home, key), JSON.stringify(all, null, 2));
  return all[chapter];
}

/** The commit a read stands for: what the story told him (story_head), else the PR head he saw. */
export const readSha = r => (r && (r.story_head || r.head_sha)) || null;

/**
 * Where an update should start.
 * @param {object} reads read.json
 * @param {{key: string, title: string, since?: object}[]} chapters the story's chapters as stories.load gives them
 * @param {string|null} fallback the commit the story was told from
 * @returns {{since_sha: string|null, source: 'read'|'story'|null, chapter: string|null, at: string|null, read: {chapter, title, sha, at}[]}}
 */
export function sinceOf(reads, chapters, fallback = null) {
  const keys = new Map((chapters || []).map(ch => [ch.key || chapterKey(ch), ch]));
  const read = Object.entries(reads || {})
    .filter(([k, r]) => keys.has(k) && r && readSha(r) && Number.isFinite(Date.parse(r.at)))
    .map(([k, r]) => ({ chapter: k, title: r.title || keys.get(k).title || k, sha: readSha(r), at: r.at, addendum: !!keys.get(k).since }));
  // reading the newest "Since you read it" chapter caught him up to its commit, so older reads don't count
  const cutoff = Math.max(0, ...read.filter(r => r.addendum).map(r => Date.parse(r.at)));
  const counted = read.filter(r => Date.parse(r.at) >= cutoff).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const list = read.map(({ addendum, ...r }) => r);
  if (counted.length) return { since_sha: counted[0].sha, source: 'read', chapter: counted[0].chapter, at: counted[0].at, read: list };
  const fb = SHA_RE.test(String(fallback || '')) ? fallback : null;
  return { since_sha: fb, source: fb ? 'story' : null, chapter: null, at: null, read: list };
}
