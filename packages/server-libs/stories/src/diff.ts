/** Unified diff parsing (the same shape once-upon uses) and GitHub's file anchors. */
import { createHash } from 'node:crypto';
import type { DiffFile, DiffHunk } from '@once-upon-a-diff/contracts/types';

export type { DiffFile, DiffHunk };

/** GitHub's "Files changed" anchor for a file is diff- + the sha256 of its path. */
export const pathSha = (rel: string): string => createHash('sha256').update(rel).digest('hex');

/** The diff file a path names: the path itself, or the one file it's a suffix of (`Combobox/component.tsx`). */
export function relOfPath(name: string | null | undefined, rels: string[]): string | null {
  const wanted = String(name || '')
    .trim()
    .replace(/^\.\//, '');
  if (!wanted) {
    return null;
  }
  if (rels.includes(wanted)) {
    return wanted;
  }
  const hits = rels.filter((rel) => rel.endsWith('/' + wanted));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A path as git writes it in a header: plain, or in C-style quotes (`"x\ty"`) when it holds a tab, a quote, a
 * backslash or a control character (and non-ASCII bytes, unless core.quotePath is off). Returns the path and what
 * follows the closing quote, or null when the text isn't a quoted path.
 */
function quotedPath(text: string): { path: string; rest: string } | null {
  if (!text.startsWith('"')) {
    return null;
  }
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const chars = Array.from(text);
  const bytes: number[] = [];
  let i = 1;
  for (; i < chars.length && chars[i] !== '"'; i++) {
    if (chars[i] !== '\\') {
      bytes.push(...Buffer.from(chars[i]));
      continue;
    }
    i++;
    const octal = /^[0-3][0-7]{2}$/.test(chars.slice(i, i + 3).join(''));
    if (octal) {
      bytes.push(parseInt(chars.slice(i, i + 3).join(''), 8));
      i += 2;
    } else {
      bytes.push(escapes[chars[i]] ?? [...Buffer.from(chars[i] ?? '')][0]);
    }
  }
  if (i >= chars.length) {
    return null;
  }
  return { path: Buffer.from(bytes).toString('utf8'), rest: chars.slice(i + 1).join('') };
}

/** A whole string that is one path, plain or quoted. */
const wholePath = (text: string): string | null => {
  const quoted = quotedPath(text);
  if (!quoted) {
    return text;
  }
  return quoted.rest ? null : quoted.path;
};

/** Whether a `diff --git` line's text, split at `half` (its middle), is `a/<path> b/<path>` with the same path on both sides. */
export const halvesNameOnePath = (text: string, half: number): boolean => {
  if (!Number.isInteger(half)) {
    return false;
  }
  const sameOnBothSides = text.slice(2, half) === text.slice(half + 3);
  const oldSideStartsA = text.startsWith('a/');
  const splitsAtSpace = text[half] === ' ';
  const newSideStartsB = text.startsWith('b/', half + 1);
  return sameOnBothSides && oldSideStartsA && splitsAtSpace && newSideStartsB;
};

/** A `diff --git` line's two paths, without the a/ and b/, whether git quoted them or not. Null when it can't tell. */
export function headerPaths(line: string): { from: string; to: string } | null {
  const text = line.replace(/^diff --git /, '');
  const first = quotedPath(text);
  let oldPath: string | null;
  let newPath: string | null;
  if (first) {
    oldPath = first.path;
    newPath = wholePath(first.rest.replace(/^ /, ''));
  } else {
    const quotedNew = text.indexOf(' "b/');
    const half = (text.length - 1) / 2;
    if (quotedNew > 0) {
      oldPath = text.slice(0, quotedNew);
      newPath = wholePath(text.slice(quotedNew + 1));
    } else if (halvesNameOnePath(text, half)) {
      // a path may hold " b/", so when both halves name one path, that is the split
      [oldPath, newPath] = [text.slice(0, half), text.slice(half + 1)];
    } else {
      const plain = /^(a\/.+) (b\/.+)$/.exec(text);
      [oldPath, newPath] = plain ? [plain[1], plain[2]] : [null, null];
    }
  }
  return oldPath?.startsWith('a/') && newPath?.startsWith('b/')
    ? { from: oldPath.slice(2), to: newPath.slice(2) }
    : null;
}

/** A hunk's header line (`@@ -5,2 +5,3 @@ fn`) as its numbers and trailing text; a count left out is 1. Null for any other line. */
export function parseHunkHeader(line: string): Omit<DiffHunk, 'lines'> | null {
  const found = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)$/.exec(line);
  if (!found) {
    return null;
  }
  return {
    oldStart: +found[1],
    oldLines: found[2] === undefined ? 1 : +found[2],
    newStart: +found[3],
    newLines: found[4] === undefined ? 1 : +found[4],
    header: found[5].trim(),
  };
}

/**
 * What a file's change says, with none of where it sits: its path, kind and rename, and only its added and removed
 * lines. Unlike `hash` (every raw line, headers and `@@` numbers included, for viewed marks) it is the same for a patch
 * re-applied onto a moved base, so "did this file change since" is not fooled by a rebase.
 */
export function contentHash(file: DiffFile): string {
  const body = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => /^[+-]/.test(line)));
  return createHash('sha1')
    .update(
      [
        file.rel,
        file.kind,
        file.renamed_from || '',
        file.binary ? `binary ${file.blobs || ''}` : '',
        ...body,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
}

/** Where `parseUnifiedDiff` stands: the file and hunk being read, and what its hash covers. */
interface ParseState {
  files: Map<string, DiffFile>;
  cur: DiffFile | null;
  hunk: DiffHunk | null;
  raw: string[];
  index: string; // the file's `index a..b` ids, as git printed them; a binary file keeps them in `blobs`
}

/** Fixes the open file's hash from the raw lines read so far. */
function closeFile(state: ParseState): void {
  if (state.cur) {
    state.cur.hash = createHash('sha1').update(state.raw.join('\n')).digest('hex').slice(0, 16);
  }
}

/** A `diff --git` line: closes the open file and opens that path's entry. */
function openFile(state: ParseState, line: string): void {
  closeFile(state);
  const names = headerPaths(line);
  const rel = names ? names.to : line.slice(11);
  // a type change (symlink to file) is two entries for one path: the second joins the first
  const again = state.files.get(rel);
  if (again) {
    state.cur = again;
  } else {
    state.cur = { rel, kind: 'modified', stats: { added: 0, removed: 0 }, hunks: [] };
    state.files.set(rel, state.cur);
    state.raw = [];
  }
  state.hunk = null;
  state.index = '';
  state.raw.push(line);
}

/** A file-level header line (kind, rename, index ids, binary), applied to the file; false when the line is not one. */
function readHeaderLine(state: ParseState, file: DiffFile, line: string): boolean {
  if (line.startsWith('new file mode')) {
    file.kind = 'created';
    return true;
  }
  if (line.startsWith('deleted file mode')) {
    file.kind = 'deleted';
    return true;
  }
  if (line.startsWith('rename from ')) {
    file.renamed_from = wholePath(line.slice(12)) ?? line.slice(12);
    file.kind = 'renamed';
    return true;
  }
  const ids = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
  if (ids) {
    // git's abbreviation length can grow with the repo: compare only the first 7
    state.index = `${ids[1].slice(0, 7)}..${ids[2].slice(0, 7)}`;
    return true;
  }
  if (line.startsWith('Binary files ')) {
    file.binary = true;
    file.blobs = state.index;
    return true;
  }
  return false;
}

/** A line inside a hunk: added, removed, context or the "no newline" marker; anything else is dropped. */
function readHunkLine(file: DiffFile, hunk: DiffHunk, line: string): void {
  if (line.startsWith('+')) {
    file.stats.added++;
  } else if (line.startsWith('-')) {
    file.stats.removed++;
  } else if (!line.startsWith(' ') && !line.startsWith('\\')) {
    return;
  }
  hunk.lines.push(line);
}

/** One line of the diff text, after a `diff --git` line has opened a file. */
function readFileLine(state: ParseState, file: DiffFile, line: string): void {
  state.raw.push(line);
  if (readHeaderLine(state, file, line)) {
    return;
  }
  const hunkHeader = parseHunkHeader(line);
  if (hunkHeader) {
    state.hunk = { ...hunkHeader, lines: [] };
    file.hunks.push(state.hunk);
  } else if (state.hunk) {
    readHunkLine(file, state.hunk, line);
  }
}

/** Unified diff -> Map(rel -> DiffFile). */
export function parseUnifiedDiff(text: string): Map<string, DiffFile> {
  const state: ParseState = { files: new Map(), cur: null, hunk: null, raw: [], index: '' };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      openFile(state, line);
    } else if (state.cur) {
      readFileLine(state, state.cur, line);
    }
  }
  closeFile(state);
  return state.files;
}
