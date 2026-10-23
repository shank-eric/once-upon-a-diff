// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * What a story folder is: whether it is one (chapters.json and meta.json),
 * what it's a story of (readMeta), and its version, which the pages poll to
 * redraw when a file changes.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '../util/json-file.ts';

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
  existsSync(path.join(dir, 'chapters.json')) && existsSync(path.join(dir, 'meta.json'));

/** What a story folder is about, from its meta.json: {kind, repo, number, title, url, head_oid, ...}. */
export function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), {}) || {};
  const plan = readJson(path.join(dir, 'chapters.json'), {}) || {};
  const out = { kind: meta.kind || 'github', ...meta };
  if (out.kind === 'github' && out.repo && out.number && !out.url) {
    out.url = `https://github.com/${out.repo}/pull/${out.number}`;
  }
  out.title = plan.title || out.title || out.pr_title || path.basename(dir);
  return out;
}

export function storyVersion(dir) {
  const files = ['chapters.json', 'file-map.json', 'meta.json', 'local.diff'];
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
