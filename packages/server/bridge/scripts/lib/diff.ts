/** The line ranges a unified diff (`git diff -U0 <base>...HEAD`) adds, by the new file's path. */
export type Added = Map<string, Array<[number, number]>>;

const FILE = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function addedLines(diff: string): Added {
  const added: Added = new Map();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    const next = FILE.exec(line);
    if (next) {
      file = next[1] === '/dev/null' ? null : (next[1] ?? null); // /dev/null: a deleted file adds nothing
      continue;
    }
    const hunk = HUNK.exec(line);
    const count = hunk?.[2] === undefined ? 1 : Number(hunk[2]);
    if (file && hunk && count > 0) {
      const start = Number(hunk[1]);
      const ranges = added.get(file) ?? [];
      ranges.push([start, start + count - 1]);
      added.set(file, ranges);
    }
  }
  return added;
}

/** Whether lines `from..to` touch any added range. */
export const touches = (ranges: Array<[number, number]>, from: number, last: number): boolean =>
  ranges.some(([start, end]) => from <= end && last >= start);
