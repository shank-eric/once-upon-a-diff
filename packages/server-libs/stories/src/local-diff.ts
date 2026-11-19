/*
 * A local story's diff: remade when a HEAD story's refs move (refreshLocal), with a -w
 * copy for Hide whitespace, and the per-file view the local page draws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import path from 'node:path';
import { parseUnifiedDiff, pathSha } from './diff.ts';
import {
  revParse,
  diffText,
  commitsBetween,
  blobText,
  mergeBase,
} from '@once-upon-a-diff/adapters/git';
import type { DiffFile, LocalFile, LocalMoved } from '@once-upon-a-diff/contracts/types';
import type { LocalMeta, StoryMeta } from './types.ts';
import { checkedMeta } from './meta.ts';
import { removeFile } from '@once-upon-a-diff/adapters/stores/fs/files';

/**
 * The same range with -w, for Hide whitespace. Made the first time it's wanted and kept in local-w.diff
 * until the refs move (refreshLocal removes it). Null when git can't make it, so the full diff is drawn.
 */
export function diffIgnoringWhitespace(dir: string, meta: StoryMeta): Map<string, DiffFile> | null {
  const file = path.join(dir, 'local-w.diff');
  if (!existsSync(file)) {
    if (!meta.repo_path || !meta.base_oid || !meta.head_oid || checkedMeta(dir, meta).problem) {
      return null;
    }
    try {
      writeFileAtomic(
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

/** The biggest file `fileLinesAt` reads, in bytes: a bigger one is refused, as it would not draw well either. */
export const FILE_LINES_MAX_BYTES = 1_000_000;

/** Why `fileLinesAt` has no lines: the file is not one of the diff's, or is gone from the head, binary or too large. */
export class FileLinesRefusal extends Error {
  readonly kind: 'not-in-diff' | 'gone' | 'binary' | 'too-large';
  constructor(kind: FileLinesRefusal['kind']) {
    super(kind);
    this.kind = kind;
  }
}

/**
 * The lines of one of the diff's files at the story's head commit, for the page's Expand controls. `rel` must be
 * exactly a file of the story's diff (never joined or tidied), and the commit is the story's own `head_oid`
 * (`meta`, as `refreshLocal` returned it), never one the page sent. Lines keep a `\r` as the diff's do, and an
 * empty last element from a final newline is dropped. Throws a FileLinesRefusal.
 */
export function fileLinesAt(dir: string, meta: StoryMeta, rel: string): string[] {
  const diff = loadDiff(dir, meta);
  if (!diff?.has(rel) || !meta.repo_path || !meta.head_oid || checkedMeta(dir, meta).problem) {
    throw new FileLinesRefusal('not-in-diff');
  }
  const blob = blobText(meta.repo_path, meta.head_oid, rel, FILE_LINES_MAX_BYTES);
  if ('refused' in blob) {
    throw new FileLinesRefusal(blob.refused);
  }
  const lines = blob.text.split('\n');
  if (blob.text.endsWith('\n') || !blob.text) {
    lines.pop();
  }
  return lines;
}

/**
 * The commit a local story's diff starts from: the merge-base of its base ref and head, so a base that moved on after the
 * branch left it does not show its own commits undone in the two-dot diff, and `base_oid` is the merge-base used. A base
 * that shares no history with the head is the base ref's tip.
 */
export function baseOidOf(repo: string, baseRef: string, headOid: string): string {
  try {
    return mergeBase(repo, baseRef, headOid);
  } catch {
    return revParse(repo, baseRef);
  }
}

/** Whether a story follows its checkout's HEAD (`--head HEAD`, the default) rather than being pinned to the commits it was told over. */
export const followsHead = (meta: Pick<LocalMeta, 'head'>): boolean => meta.head === 'HEAD';

/**
 * `meta` is the raw meta.json. A story over `--head HEAD` follows the checkout: when HEAD (or the base ref) has
 * moved since the diff was made, remake local.diff. Viewed marks are kept per file diff, so a file whose diff
 * changed shows as unviewed again.
 *
 * `meta` is checked first (checkedMeta): a meta.json a checked-out branch has overwritten reaches no git call. A
 * problem leaves the story as it is (no diff made, nothing written) and returns the cleaned meta.
 *
 * Any other `--head` (a branch, a commit, HEAD~1) is pinned to the base_oid and head_oid stored when it was told:
 * a restack or a new commit on that branch does not change the story (movedSince says it did). Telling it again
 * (`once-upon local`) pins it to the tips as they are then.
 */
export function refreshLocal(dir: string, given: LocalMeta): LocalMeta {
  const checked = checkedMeta(dir, given);
  if (checked.problem || checked.meta.kind !== 'local') {
    return checked.meta as LocalMeta; // a bad field is already dropped from it
  }
  const meta = checked.meta as LocalMeta;
  const hasDiff = existsSync(path.join(dir, 'local.diff'));
  if (!followsHead(meta) && meta.base_oid && meta.head_oid) {
    if (!hasDiff) {
      try {
        writeFileAtomic(
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
    headOid = revParse(meta.repo_path, meta.head);
    baseOid = baseOidOf(meta.repo_path, meta.base, headOid);
  } catch {
    return meta; // repo or ref gone: keep the last diff
  }
  if (baseOid === meta.base_oid && headOid === meta.head_oid && hasDiff) {
    return meta;
  }
  // a head the base now holds (the branch landed in it) has the merge-base at itself: the story keeps its range, so it is not
  // taken for one with no commits of its own, which the delivered check leaves alone
  if (baseOid === headOid && headOid === meta.head_oid && meta.base_oid && hasDiff) {
    return meta;
  }
  writeFileAtomic(path.join(dir, 'local.diff'), diffText(meta.repo_path, baseOid, headOid));
  removeFile(path.join(dir, 'local-w.diff')); // remade for the new range when Hide whitespace wants it
  const next = {
    ...meta,
    base_oid: baseOid,
    head_oid: headOid,
    commits: commitsBetween(meta.repo_path, baseOid, headOid),
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dir, 'meta.json'), next);
  return next;
}

/**
 * For a pinned story, where its base (the merge-base of the base ref and head, as told) and head refs are now when that is not where the story was told: the current
 * commit of each ref that moved (the other is null), or null when nothing moved, the story follows HEAD, or a ref
 * can't be read (the repo or branch is gone).
 */
export function movedSince(meta: LocalMeta): LocalMoved | null {
  if (followsHead(meta) || !meta.base_oid || !meta.head_oid) {
    return null;
  }
  try {
    const head = revParse(meta.repo_path, meta.head);
    const base = baseOidOf(meta.repo_path, meta.base, head);
    // a story told before the merge-base stored the base ref's tip: it did not move if that tip has the same merge-base
    const unmoved =
      base === meta.base_oid ||
      (!!meta.base_oid && baseOidOf(meta.repo_path, meta.base_oid, head) === base);
    if (unmoved && head === meta.head_oid) {
      return null;
    }
    return {
      base_oid: unmoved ? null : base,
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
