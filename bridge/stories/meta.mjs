/*
 * What a story folder is: whether it is one (chapters.json plus file-map.json,
 * meta.json or pr.json), what it's a story of (readMeta), and its version,
 * which the pages poll to redraw when a file changes.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '../util/json-file.mjs';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A file's modification time in ms, or 0 when it's missing. */
export function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export const isStoryDir = (dir) =>
  existsSync(path.join(dir, 'chapters.json')) &&
  ['file-map.json', 'meta.json', 'pr.json'].some((name) => existsSync(path.join(dir, name)));

/** What a story folder is about: {kind, id, repo, number, title, url, ...}. */
export function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), {}) || {};
  const pr = readJson(path.join(dir, 'pr.json'), null);
  const map = readJson(path.join(dir, 'file-map.json'), null);
  const plan = readJson(path.join(dir, 'chapters.json'), {}) || {};
  const out = { kind: meta.kind || 'github', ...meta };
  if (out.kind === 'github') {
    if (pr && pr.url) {
      const [owner, repo] = pr.url.split('/').slice(3, 5);
      out.repo ||= `${owner}/${repo}`;
      out.number ||= pr.number;
      out.url ||= pr.url;
      out.pr_title ||= pr.title;
      out.head_oid ||= pr.headRefOid || null; // the commit the story was told from
      out.base_oid ||= pr.baseRefOid || null;
    }
    if (map && typeof map.pr === 'string' && !out.repo) {
      const match = /^(.+)#(\d+)$/.exec(map.pr);
      if (match) {
        out.repo = match[1];
        out.number = +match[2];
      }
    }
    if (out.repo && out.number && !out.url) {
      out.url = `https://github.com/${out.repo}/pull/${out.number}`;
    }
  }
  out.title = plan.title || out.title || out.pr_title || path.basename(dir);
  return out;
}

export function storyVersion(dir) {
  const files = ['chapters.json', 'file-map.json', 'meta.json', 'local.diff', 'backstory.json'];
  return String(Math.max(...files.map((name) => modifiedAt(path.join(dir, name)))));
}

/**
 * A local story's version also says whether whitespace is hidden and which diff view is on, so a page
 * that polls it redraws when a setting changes in another tab.
 */
export const localVersion = (dir, prefs) =>
  storyVersion(dir) +
  (prefs && prefs.hideWhitespace ? '-w' : '') +
  (prefs && prefs.diffView === 'split' ? '-s' : '');
