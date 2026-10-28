/*
 * A local story's diff: remade when a HEAD story's refs move (refreshLocal), with a -w
 * copy for Hide whitespace, and the per-file view the local page draws.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff, pathSha } from '../util/diff.ts';
import { revParse, diffText, commitsBetween } from '../util/git.ts';
import type { DiffFile, LocalFile, LocalMoved } from '@once-upon-a-diff/shared/types';
import type { LocalMeta, StoryMeta } from '../types.ts';

/**
 * The same range with -w, for Hide whitespace. Made the first time it's wanted and kept in local-w.diff
 * until the refs move (refreshLocal removes it). Null when git can't make it, so the full diff is drawn.
 */
export function diffIgnoringWhitespace(dir: string, meta: StoryMeta): Map<string, DiffFile> | null {
  const file = path.join(dir, 'local-w.diff');
  if (!existsSync(file)) {
    if (!meta.repo_path || !meta.base_oid || !meta.head_oid) {
      return null;
    }
    try {
      writeFileSync(
        file,
        diffText(meta.repo_path, meta.base_oid, meta.head_oid, { ignoreWhitespace: true }),
      );
    } catch {
      return null;
    }
  }
  return parseUnifiedDiff(readFileSync(file, 'utf8'));
}

/** The story's diff: local.diff, or pr.diff when GitHub doesn't draw it. Null when there's none to draw. */
export function loadDiff(dir: string, meta: StoryMeta): Map<string, DiffFile> | null {
  const file = ['local.diff', 'pr.diff']
    .map((name) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));
  if (!file) {
    return null;
  }
  if (
    meta.kind !== 'local' &&
    file.endsWith('pr.diff') &&
    existsSync(path.join(dir, 'file-map.json'))
  ) {
    return null; // GitHub draws the diff
  }
  return parseUnifiedDiff(readFileSync(file, 'utf8'));
}

/** Whether a story follows its checkout's HEAD (`--head HEAD`, the default) rather than being pinned to the commits it was told over. */
export const followsHead = (meta: Pick<LocalMeta, 'head'>): boolean => meta.head === 'HEAD';

/**
 * `meta` is the raw meta.json. A story over `--head HEAD` follows the checkout: when HEAD (or the base ref) has
 * moved since the diff was made, remake local.diff. Viewed marks are kept per file diff, so a file whose diff
 * changed shows as unviewed again.
 *
 * Any other `--head` (a branch, a commit, HEAD~1) is pinned to the base_oid and head_oid stored when it was told:
 * a restack or a new commit on that branch does not change the story (movedSince says it did). Telling it again
 * (`once-upon local`) pins it to the tips as they are then.
 */
export function refreshLocal(dir: string, meta: LocalMeta): LocalMeta {
  const hasDiff = existsSync(path.join(dir, 'local.diff'));
  if (!followsHead(meta) && meta.base_oid && meta.head_oid) {
    if (!hasDiff) {
      try {
        writeFileSync(
          path.join(dir, 'local.diff'),
          diffText(meta.repo_path, meta.base_oid, meta.head_oid),
        );
      } catch {
        // the commits are gone from the repo: nothing to draw
      }
    }
    return meta;
  }
  let baseOid;
  let headOid;
  try {
    baseOid = revParse(meta.repo_path, meta.base);
    headOid = revParse(meta.repo_path, meta.head);
  } catch {
    return meta; // repo or ref gone: keep the last diff
  }
  if (baseOid === meta.base_oid && headOid === meta.head_oid && hasDiff) {
    return meta;
  }
  writeFileSync(path.join(dir, 'local.diff'), diffText(meta.repo_path, baseOid, headOid));
  rmSync(path.join(dir, 'local-w.diff'), { force: true }); // remade for the new range when Hide whitespace wants it
  const next = {
    ...meta,
    base_oid: baseOid,
    head_oid: headOid,
    commits: commitsBetween(meta.repo_path, baseOid, headOid),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
  return next;
}

/**
 * For a pinned story, where its base and head refs point now when that is not where the story was told: the current
 * commit of each ref that moved (the other is null), or null when nothing moved, the story follows HEAD, or a ref
 * can't be read (the repo or branch is gone).
 */
export function movedSince(meta: LocalMeta): LocalMoved | null {
  if (followsHead(meta) || !meta.base_oid || !meta.head_oid) {
    return null;
  }
  try {
    const base = revParse(meta.repo_path, meta.base);
    const head = revParse(meta.repo_path, meta.head);
    if (base === meta.base_oid && head === meta.head_oid) {
      return null;
    }
    return {
      base_oid: base === meta.base_oid ? null : base,
      head_oid: head === meta.head_oid ? null : head,
    };
  } catch {
    return null;
  }
}

/**
 * Each file as the local page draws it. Hide whitespace changes what's drawn (hunks, stats) but not what a file
 * is: the file list and the hash that viewed marks are checked against always come from the full diff, so the
 * toggle never flips them.
 */
export function localFilesOf(
  rels: string[],
  diff: Map<string, DiffFile> | null,
  shown: Map<string, DiffFile> | null,
  viewed: Record<string, { hash?: string }>,
): LocalFile[] {
  return rels.map((rel) => {
    const file = diff && diff.get(rel);
    const mark = viewed[rel];
    const withoutWhitespace =
      shown && file && !file.binary
        ? shown.get(rel) || { stats: { added: 0, removed: 0 }, hunks: [] }
        : null;
    const drawn = withoutWhitespace || file;
    return {
      rel,
      sha: pathSha(rel),
      kind: file ? file.kind : 'modified',
      stats: drawn ? drawn.stats : { added: 0, removed: 0 },
      hunks: drawn ? drawn.hunks : [],
      renamed_from: file && file.renamed_from ? file.renamed_from : null,
      binary: !!(file && file.binary),
      hash: file ? file.hash : null,
      whitespace_only: !!(
        withoutWhitespace &&
        file!.hunks.length && // withoutWhitespace is only made for a file of the diff
        !withoutWhitespace.hunks.length
      ),
      viewed: !!(mark && file && mark.hash === file.hash),
      viewed_changed: !!(mark && file && mark.hash !== file.hash),
    };
  });
}
