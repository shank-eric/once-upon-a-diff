/**
 * Local mode: a story over a local commit range instead of a GitHub PR. The
 * story lives in the checkout (or worktree) it diffs, at <top>/.once-upon/<id>/,
 * kept out of git by .git/info/exclude (placement.mjs). The folder holds meta.json (repo, refs), local.diff (remade whenever the
 * refs move) and chapters.json in once-upon's format, so the same panel and
 * the same chapters work on either.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { topLevel, revParse, branchName } from '../util/git.mjs';
import { parseUnifiedDiff } from '../util/diff.mjs';
import { refreshLocal } from './local-diff.mjs';
import { entryOf } from './chapters.mjs';
import { ID_RE } from './meta.mjs';
import { storyDirFor } from './placement.mjs';
import { repoOfCheckout, seenCheckout } from '../config/repos.mjs';
import { plural } from '@once-upon-a-diff/shared/util/text';

export const slug = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

const WORKSPACE_FOLDERS = ['apps', 'libs', 'packages', 'tools', 'services'];
/** A file's group: its package in a monorepo (apps/x), else its top-level folder, else (root). */
function groupOf(rel) {
  const parts = rel.split('/');
  if (parts.length > 2 && WORKSPACE_FOLDERS.includes(parts[0])) {
    return parts.slice(0, 2).join('/');
  }
  return parts.length > 1 ? parts[0] : '(root)';
}

/** One chapter per top-level folder: a starting point until a real story is written. */
export function defaultChapters(rels, title) {
  const groups = new Map();
  for (const rel of rels) {
    const key = groupOf(rel);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(rel);
  }
  const chapters = [...groups].map(([key, files], i) => ({
    title: `Chapter ${i + 1}: ${key}`,
    summary: `${plural(files.length, 'file')} under ${key}.`,
    narrative: '',
    files,
  }));
  return {
    mode: 'by-folder',
    title,
    overview: `No story has been written for these commits yet, so each chapter is a folder. Write a chapters.json (once-upon's format) and run \`once-upon local\` again with \`--chapters\` to tell it properly.`,
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
}) {
  const top = topLevel(repo);
  revParse(top, base); // fail early on a bad ref
  revParse(top, head);
  const branch = branchName(top);
  const name = path.basename(top);
  id = id || slug(`local-${name}-${branch || head}`);
  if (!ID_RE.test(id)) {
    throw new Error(`bad story id: ${id}`);
  }
  const dir = storyDirFor(home, id, { checkout: top });
  const origin = repoOfCheckout(top);
  if (origin) {
    seenCheckout(home, origin, top);
  }
  const metaFile = path.join(dir, 'meta.json');
  const old = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const sameRange = old.repo_path === top && old.base === base && old.head === head;
  const meta = {
    kind: 'local',
    repo_path: top,
    repo_name: name,
    base,
    head,
    branch,
    base_oid: sameRange ? old.base_oid : null,
    head_oid: sameRange ? old.head_oid : null, // null makes the diff get remade
    title: title || old.title || `${name}: ${base}..${head}${branch ? ` (${branch})` : ''}`,
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  refreshLocal(dir, meta);

  const diff = parseUnifiedDiff(readFileSync(path.join(dir, 'local.diff'), 'utf8'));
  const rels = [...diff.keys()];
  const chaptersFile = path.join(dir, 'chapters.json');
  if (chapters) {
    const after = JSON.parse(readFileSync(path.resolve(chapters), 'utf8'));
    const before = existsSync(chaptersFile) ? JSON.parse(readFileSync(chaptersFile, 'utf8')) : {};
    const vetted = vet ? vet({ id, meta, diff, before, after }) : null;
    if (vetted) {
      writeFileSync(chaptersFile, JSON.stringify(vetted, null, 2));
      writeFileSync(path.resolve(chapters), JSON.stringify(vetted, null, 2));
    } else {
      copyFileSync(path.resolve(chapters), chaptersFile);
    }
  }
  if (!existsSync(chaptersFile)) {
    writeFileSync(chaptersFile, JSON.stringify(defaultChapters(rels, meta.title), null, 2));
  }

  const plan = JSON.parse(readFileSync(chaptersFile, 'utf8'));
  const placed = new Set(
    (plan.chapters || []).flatMap((chapter) => (chapter.files || []).map((e) => entryOf(e).rel)),
  );
  return {
    id,
    dir,
    files: rels.length,
    chapters: (plan.chapters || []).length,
    unplaced: rels.filter((rel) => !placed.has(rel)),
    unknown: [...placed].filter((rel) => !diff.has(rel)),
  };
}
