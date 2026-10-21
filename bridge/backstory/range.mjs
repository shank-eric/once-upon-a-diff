/*
 * The commit range a backstory is for: its commits (with their files and
 * added lines), the checkouts it could have been made in, and the final diff,
 * with line ranges on the final diff's new side for a moment's added lines.
 */
import { parseUnifiedDiff } from '../util/diff.mjs';
import { runGit as git } from '../util/git.mjs';

/** The commit range: commits, their files and added lines, and the final diff. */
export function readRange(repo, base, head = 'HEAD') {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const baseOid = git(top, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const headOid = git(top, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const roots = new Set([top]);
  try {
    for (const line of git(top, ['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ')) {
        roots.add(line.slice(9));
      }
    }
  } catch {
    /* no worktrees */
  }
  // macOS: /var and /tmp are links into /private, and transcripts keep whichever spelling the session used
  for (const root of [...roots]) {
    if (root.startsWith('/private/')) {
      roots.add(root.slice(8));
    }
  }
  const log = git(top, ['log', '--format=%H%x09%aI%x09%cI%x09%s', `${baseOid}..${headOid}`]).trim();
  const commits = (log ? log.split('\n') : [])
    .map((line) => {
      const [sha, authored, committed, subject] = line.split('\t');
      const diff = parseUnifiedDiff(
        git(top, [
          '-c',
          'core.quotePath=false',
          'show',
          '--no-color',
          '--no-ext-diff',
          '--format=',
          '--unified=0',
          sha,
        ]),
      );
      return {
        sha,
        short: sha.slice(0, 11),
        authored,
        at: committed,
        subject,
        files: [...diff.keys()],
        added: addedByFile(diff),
      };
    })
    .reverse();
  const final = parseUnifiedDiff(
    git(top, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      baseOid,
      headOid,
    ]),
  );
  return { top, roots: [...roots], base, head, baseOid, headOid, commits, final };
}

/** rel -> [added line text] for a parsed diff. */
function addedByFile(diff) {
  const out = {};
  for (const [rel, file] of diff) {
    out[rel] = file.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
    );
  }
  return out;
}

/** rel -> Map(trimmed text -> [new-side line numbers]) for the added lines of the final diff. */
export function finalLineIndex(final) {
  const idx = {};
  for (const [rel, file] of final) {
    const byText = new Map();
    for (const hunk of file.hunks) {
      let lineNumber = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          const text = line.slice(1).trim();
          if (text && text.length > 2) {
            if (!byText.has(text)) {
              byText.set(text, []);
            }
            byText.get(text).push(lineNumber);
          }
          lineNumber++;
        } else if (line.startsWith(' ')) {
          lineNumber++;
        }
      }
    }
    idx[rel] = byText;
  }
  return idx;
}

/** Added line texts -> merged [start, end] ranges on the final diff's new side. */
export function rangesFor(index, rel, texts) {
  const byText = index[rel];
  if (!byText) {
    return [];
  }
  const nums = new Set();
  for (const text of texts) {
    for (const lineNumber of byText.get(String(text).trim()) || []) {
      nums.add(lineNumber);
    }
  }
  const sorted = [...nums].sort((first, second) => first - second);
  const out = [];
  for (const lineNumber of sorted) {
    const last = out[out.length - 1];
    if (last && lineNumber <= last[1] + 2) {
      last[1] = lineNumber;
    } else {
      out.push([lineNumber, lineNumber]);
    }
  }
  return out;
}

/** Merged [start, end] ranges: overlapping, or within two lines of each other. */
export function mergeRanges(ranges) {
  const sorted = ranges.map((range) => [...range]).sort((first, second) => first[0] - second[0]);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1] + 2) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      out.push(range);
    }
  }
  return out;
}
