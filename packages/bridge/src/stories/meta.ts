/*
 * What a story folder is: whether it is one (chapters.json and meta.json),
 * what it's a story of (readMeta), and its version, which the pages poll to
 * redraw when a file changes.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '../util/json-file.ts';
import type { LocalMoved } from '@once-upon-a-diff/shared/types';
import type { Prefs } from '../config/settings.ts';
import type { StoryMeta } from '../types.ts';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A file's modification time in ms, or 0 when it's missing. */
export function modifiedAt(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export const isStoryDir = (dir: string): boolean =>
  existsSync(path.join(dir, 'chapters.json')) && existsSync(path.join(dir, 'meta.json'));

/** What a story folder is about, from its meta.json: {kind, repo, number, title, url, head_oid, ...}. */
export function readMeta(dir: string): StoryMeta & { title: string } {
  const meta = readJson<Partial<StoryMeta>>(path.join(dir, 'meta.json'), {}) || {};
  const plan = readJson<{ title?: string }>(path.join(dir, 'chapters.json'), {}) || {};
  const out: StoryMeta = { kind: meta.kind || 'github', ...meta };
  if (out.kind === 'github' && out.repo && out.number && !out.url) {
    out.url = `https://github.com/${out.repo}/pull/${out.number}`;
  }
  out.title = plan.title || out.title || out.pr_title || path.basename(dir);
  return out as StoryMeta & { title: string };
}

export function storyVersion(dir: string): string {
  const files = ['chapters.json', 'file-map.json', 'meta.json', 'local.diff'];
  return String(Math.max(...files.map((name) => modifiedAt(path.join(dir, name)))));
}

/**
 * A local story's version also says whether whitespace is hidden and which diff view is on, so a page
 * that polls it redraws when a setting changes in another tab, and where a pinned story's branch has moved to,
 * so the page draws its "branch moved" notice.
 */
export const localVersion = (
  dir: string,
  prefs: Prefs | null,
  moved: LocalMoved | null = null,
): string =>
  storyVersion(dir) +
  (prefs && prefs.hideWhitespace ? '-w' : '') +
  (prefs && prefs.diffView === 'split' ? '-s' : '') +
  (moved ? `-m${(moved.head_oid || '').slice(0, 7)}${(moved.base_oid || '').slice(0, 7)}` : '');

/**
 * The login of a PR story's author: from its meta.json (`pr_author`, written when it was published), else from the
 * pr.json beside the story or in the once-upon folder it was published from (a story made before meta.json kept it).
 * Null when none says.
 */
export function prAuthorOf(dir: string, meta: StoryMeta): string | null {
  if (meta.pr_author) {
    return meta.pr_author;
  }
  for (const folder of [dir, meta.source]) {
    if (folder) {
      const pr = readJson<{ author?: { login?: string } | null }>(
        path.join(folder, 'pr.json'),
        null,
      );
      if (pr && pr.author && pr.author.login) {
        return pr.author.login;
      }
    }
  }
  return null;
}
