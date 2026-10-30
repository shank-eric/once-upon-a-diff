/** Unified diff parsing (the same shape once-upon uses) and GitHub's file anchors. */
import { createHash } from 'node:crypto';
import type { DiffFile, DiffHunk } from '@once-upon-a-diff/shared/types';

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
    if (quotedNew > 0) {
      oldPath = text.slice(0, quotedNew);
      newPath = wholePath(text.slice(quotedNew + 1));
    } else {
      const plain = /^(a\/.+) (b\/.+)$/.exec(text);
      [oldPath, newPath] = plain ? [plain[1], plain[2]] : [null, null];
    }
  }
  return oldPath?.startsWith('a/') && newPath?.startsWith('b/')
    ? { from: oldPath.slice(2), to: newPath.slice(2) }
    : null;
}

/** Unified diff -> Map(rel -> DiffFile). */
export function parseUnifiedDiff(text: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let raw: string[] = [];
  const close = () => {
    if (cur) {
      cur.hash = createHash('sha1').update(raw.join('\n')).digest('hex').slice(0, 16);
    }
    raw = [];
  };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      close();
      const names = headerPaths(line);
      cur = {
        rel: names ? names.to : line.slice(11),
        kind: 'modified',
        stats: { added: 0, removed: 0 },
        hunks: [],
      };
      files.set(cur.rel, cur);
      hunk = null;
      raw.push(line);
      continue;
    }
    if (!cur) {
      continue;
    }
    raw.push(line);
    if (line.startsWith('new file mode')) {
      cur.kind = 'created';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.kind = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.renamed_from = wholePath(line.slice(12)) ?? line.slice(12);
      cur.kind = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ')) {
      cur.binary = true;
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunkHeader) {
      hunk = {
        oldStart: +hunkHeader[1],
        oldLines: hunkHeader[2] === undefined ? 1 : +hunkHeader[2],
        newStart: +hunkHeader[3],
        newLines: hunkHeader[4] === undefined ? 1 : +hunkHeader[4],
        header: hunkHeader[5].trim(),
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push(line);
      cur.stats.added++;
    } else if (line.startsWith('-')) {
      hunk.lines.push(line);
      cur.stats.removed++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push(line);
    } else if (line.startsWith('\\')) {
      hunk.lines.push(line);
    }
  }
  close();
  return files;
}
