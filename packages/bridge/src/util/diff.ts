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
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = {
        rel: names ? names[2] : line.slice(11),
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
      cur.renamed_from = line.slice(12);
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
