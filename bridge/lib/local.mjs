/**
 * Local mode: a story over a local commit range instead of a GitHub PR. The
 * story lives in the checkout (or worktree) it diffs, at <top>/.diff-story/<id>/,
 * kept out of git by .git/info/exclude (place.mjs). The folder holds meta.json (repo, refs), local.diff (remade whenever the
 * refs move) and chapters.json in pr-story's format, so the same panel and
 * the same chapters work on either.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { topLevel, revParse, branchName } from './git.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { refreshLocal, entryOf, ID_RE } from './stories.mjs';
import { storyDirFor, moveStory, STORY_FOLDER } from './place.mjs';
import { repoOfCheckout, seenCheckout } from './repos.mjs';

export const slug = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

/** One chapter per top-level folder: a starting point until a real story is written. */
export function defaultChapters(rels, title) {
  const groups = new Map();
  for (const rel of rels) {
    const parts = rel.split('/');
    const key =
      parts.length > 2 && ['apps', 'libs', 'packages', 'tools', 'services'].includes(parts[0])
        ? parts.slice(0, 2).join('/')
        : parts.length > 1
          ? parts[0]
          : '(root)';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(rel);
  }
  const chapters = [...groups].map(([key, files], i) => ({
    title: `Chapter ${i + 1}: ${key}`,
    summary: `${files.length} file${files.length === 1 ? '' : 's'} under ${key}.`,
    narrative: '',
    files,
  }));
  return {
    mode: 'by-folder',
    title,
    overview: `No story has been written for these commits yet, so each chapter is a folder. Write a chapters.json (pr-story's format) and run \`diff-story local\` again with \`--chapters\` to tell it properly.`,
    chapters,
  };
}

export function createLocalStory({
  home,
  repo,
  base,
  head = 'HEAD',
  chapters,
  backstory,
  id,
  title,
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
  // a story made before stories moved into checkouts comes along
  const inRepo = path.join(top, STORY_FOLDER, id);
  if (!existsSync(inRepo) && existsSync(path.join(home, id, 'meta.json'))) {
    moveStory(path.join(home, id), inRepo);
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
    copyFileSync(path.resolve(chapters), chaptersFile);
  }
  if (backstory) {
    copyFileSync(path.resolve(backstory), path.join(dir, 'backstory.json'));
  } else if (!existsSync(chaptersFile)) {
    writeFileSync(chaptersFile, JSON.stringify(defaultChapters(rels, meta.title), null, 2));
  }

  const plan = JSON.parse(readFileSync(chaptersFile, 'utf8'));
  const placed = new Set(
    (plan.chapters || []).flatMap((ch) => (ch.files || []).map((e) => entryOf(e).rel)),
  );
  return {
    id,
    dir,
    files: rels.length,
    chapters: (plan.chapters || []).length,
    unplaced: rels.filter((r) => !placed.has(r)),
    unknown: [...placed].filter((r) => !diff.has(r)),
  };
}
