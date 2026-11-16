/*
 * Expand: showing the unchanged lines between a file's hunks, as GitHub's arrows do. The page has only the hunks the bridge
 * sent (git's three lines of context), so the unchanged text comes from the bridge on a click (POST .../lines) and is joined into
 * the hunks here: lines are added to a hunk (up or down) or the two hunks around a gap become one. Everything the page draws
 * (rows, anchors, split view, the `@@` row's counts) then works on the new hunks unchanged. Pure, no DOM, so node tests it.
 *
 * A gap is named by the index of the hunk below it (`index`): 0 is the lines before the first hunk, `hunks.length` the lines
 * after the last one, whose size the page doesn't know until it has the file's text.
 */
import type { DiffHunk } from '/assets/types.ts';

/** How many lines one Expand up or down adds. */
export const EXPAND_STEP = 20;

export type Direction = 'up' | 'down' | 'all';

/** git's default context: a last hunk with fewer lines than this after its last change ends the file. */
const CONTEXT = 3;

/** A hunk's first line on each side. A side with no lines in the hunk has its start as "the line before" (`@@ -3,0 +4,2 @@`). */
const firstOld = (hunk: DiffHunk) => (hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart);
const firstNew = (hunk: DiffHunk) => (hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart);
/** A hunk's last line on each side (the line before its first when it has none there). */
const lastOld = (hunk: DiffHunk) => firstOld(hunk) + hunk.oldLines - 1;
const lastNew = (hunk: DiffHunk) => firstNew(hunk) + hunk.newLines - 1;

const isLine = (line: string) => line[0] !== '\\';

/** Whether the last hunk reaches the end of the file: it has the "no newline" marker, or fewer than git's trailing context lines. */
function endsFile(hunk: DiffHunk): boolean {
  if (hunk.lines.some((line) => !isLine(line))) {
    return true;
  }
  let context = 0;
  for (let i = hunk.lines.length - 1; i >= 0 && hunk.lines[i][0] === ' '; i--) {
    context++;
  }
  return context < CONTEXT;
}

/** A hunk of these lines, its start and counts made true again (a side with no lines keeps the line before as its start). */
function hunkOf(header: string, oldFirst: number, newFirst: number, lines: string[]): DiffHunk {
  const count = (signs: string) =>
    lines.filter((line) => isLine(line) && signs.includes(line[0])).length;
  const oldLines = count(' -');
  const newLines = count(' +');
  return {
    oldStart: oldLines === 0 ? oldFirst - 1 : oldFirst,
    oldLines,
    newStart: newLines === 0 ? newFirst - 1 : newFirst,
    newLines,
    header,
    lines,
  };
}

/** A gap with unseen lines: `hidden` is how many, or null for the lines after the last hunk (not known until the text is). */
export interface Gap {
  index: number;
  hidden: number | null;
}

/** The gaps of a file's hunks that have lines to show, in order. The one after the last hunk is there unless the hunk ends the file. */
export function gapsOf(hunks: readonly DiffHunk[]): Gap[] {
  const gaps: Gap[] = [];
  hunks.forEach((hunk, index) => {
    const hidden = firstNew(hunk) - 1 - (index ? lastNew(hunks[index - 1]) : 0);
    if (hidden > 0) {
      gaps.push({ index, hidden });
    }
  });
  if (hunks.length && !endsFile(hunks[hunks.length - 1])) {
    gaps.push({ index: hunks.length, hidden: null });
  }
  return gaps;
}

/**
 * The hunks with a gap opened: `down` adds `step` unchanged lines to the hunk above it, `up` to the hunk below, and `all`
 * (or a gap no bigger than `step`) fills it, joining the two hunks into one that keeps the first one's header. `text` is
 * the file's lines at the head, the new side that the page draws; an unchanged line has the same text on both sides, and
 * its old number is its new number less what the hunks above added. `added` is the new-side numbers of the lines put in.
 * The hunks come back as the same array when there was nothing to open (a gap that isn't there, or the end of the file).
 */
export function expandHunks(
  hunks: readonly DiffHunk[],
  text: readonly string[],
  index: number,
  direction: Direction,
  step = EXPAND_STEP,
): { hunks: DiffHunk[]; added: number[] } {
  const above = index > 0 ? hunks[index - 1] : undefined;
  const below = index < hunks.length ? hunks[index] : undefined;
  if (!above && !below) {
    return { hunks: hunks as DiffHunk[], added: [] };
  }
  const from = above ? lastNew(above) + 1 : 1;
  const stop = below ? firstNew(below) - 1 : text.length;
  const hidden = stop - from + 1;
  if (hidden <= 0 || (direction === 'down' && !above) || (direction === 'up' && !below)) {
    return { hunks: hunks as DiffHunk[], added: [] };
  }
  // the lines above the gap added or removed move the old numbers off the new ones by `delta`
  const delta = above ? lastNew(above) - lastOld(above) : 0;
  const fill = direction === 'all' || hidden <= step;
  const first = fill || direction === 'down' ? from : stop - step + 1;
  const last = fill || direction === 'up' ? stop : from + step - 1;
  const added: number[] = [];
  const lines: string[] = [];
  for (let num = first; num <= last; num++) {
    added.push(num);
    lines.push(` ${text[num - 1]}`);
  }
  const out = hunks.slice();
  if (above && below && fill) {
    out.splice(
      index - 1,
      2,
      hunkOf(above.header, firstOld(above), firstNew(above), [
        ...above.lines,
        ...lines,
        ...below.lines,
      ]),
    );
  } else if (above && (direction === 'down' || !below)) {
    out[index - 1] = hunkOf(above.header, firstOld(above), firstNew(above), [
      ...above.lines,
      ...lines,
    ]);
  } else if (below) {
    out[index] = hunkOf(below.header, first - delta, first, [...lines, ...below.lines]);
  }
  return { hunks: out, added };
}
