/*
 * The local page's line narrowing: in a chapter, the lines of a file that
 * other chapters tell (their `lines` ranges) fold away behind one row, so a
 * file two chapters share shows each chapter its own part. Lines no chapter's
 * ranges cover go with the first chapter that lists the file ("Since you read
 * it" chapters aside), so each line is shown in some chapter. A chapter that
 * lists the file without line ranges sees all of it, and so do the Overview
 * and "Show all files". A folded run is one click to open.
 *
 * Pure functions over a plain row model, so they're tested in node; local.js
 * reads the rows off its tables and applies the result.
 */

/** Lines on one side of a file. */
interface Range {
  side: 'L' | 'R';
  start: number;
  end: number;
}

/** What claimsOf reads of a chapter (the story's chapters, or chapters.json's own). */
interface ClaimChapter {
  since?: unknown;
  files?: {
    rel: string;
    lines?: ({ side?: string; start: number | string; end?: number | string } | null)[];
  }[];
}

/** steps[step - 1]: the ranges each step gives each file (null for the whole file); home[rel]: the step for the rest. */
export interface Claims {
  steps: Record<string, Range[] | null>[];
  home: Record<string, number>;
}

/** A table row as narrowRows reads it: a line row has its old and new numbers (L, R) and whether it adds (add). */
export interface NarrowRow {
  type: 'hunk' | 'note' | 'info' | 'line';
  L?: number | null;
  R?: number | null;
  add?: boolean;
}

/** A run of hidden rows to fold behind one row, and the steps that tell them. */
export interface NarrowRun {
  from: number;
  to: number;
  steps: number[];
}

/**
 * {steps, home}: steps[step - 1] is {rel -> [{side, start, end}] | null}, the ranges each step gives each file
 * (null for "the whole file"), and home[rel] the step that shows the lines no range covers.
 */
export function claimsOf(chapters: ClaimChapter[] | null | undefined): Claims {
  const home: Record<string, number> = {};
  (chapters || []).forEach((chapter, i) => {
    if (!chapter.since) {
      for (const file of chapter.files || []) {
        if (!(file.rel in home)) {
          home[file.rel] = i + 1;
        }
      }
    }
  });
  const steps = (chapters || []).map((chapter) => {
    const out: Record<string, Range[] | null> = {};
    for (const file of chapter.files || []) {
      const ranges = (file.lines || []).filter((line) => line && Number.isFinite(+line.start));
      out[file.rel] = ranges.length
        ? ranges.map((line) => ({
            side: (line!.side === 'L' ? 'L' : 'R') as Range['side'],
            start: +line!.start,
            end: +(line!.end || line!.start),
          }))
        : null;
    }
    return out;
  });
  return { steps, home };
}

/** The steps (1-based) whose ranges for rel cover side:num. */
function stepsAt(
  claims: Claims,
  rel: string,
  side: Range['side'],
  num: number | null | undefined,
): Set<number> {
  const out = new Set<number>();
  if (num == null) {
    return out;
  }
  claims.steps.forEach((byRel, i) => {
    const ranges = byRel[rel];
    if (
      ranges &&
      ranges.some((range) => range.side === side && num >= range.start && num <= range.end)
    ) {
      out.add(i + 1);
    }
  });
  return out;
}
const union = (...sets: Set<number>[]) => new Set(sets.flatMap((set) => [...set]));

/**
 * rows: [{type: 'hunk'} | {type: 'line', L, R, add} | {type: 'note'} | {type: 'info'}] in table order,
 * L and R being the row's old and new line numbers (null when it has none) and add whether its new side is an added line.
 * Returns {hidden: [bool per row], runs: [{from, to, steps: [step]}]}: the runs of hidden rows, each to fold behind one row,
 * with the steps that tell them. Nothing is hidden when step n lists rel without ranges, or doesn't list it.
 */
export function narrowRows(
  rows: NarrowRow[],
  claims: Claims,
  rel: string,
  step: number,
): { hidden: boolean[]; runs: NarrowRun[] } {
  const hidden = rows.map(() => false);
  const own = claims.steps[step - 1] && claims.steps[step - 1][rel];
  if (!own) {
    return { hidden, runs: [] };
  }
  // each line row's claiming steps: by its new line, and by its old line
  // a set for each line row, null for the rest
  const claimedBy: (Set<number> | null)[] = rows.map((row) =>
    row.type === 'line'
      ? union(stepsAt(claims, rel, 'R', row.R), stepsAt(claims, rel, 'L', row.L))
      : null,
  );
  // a removed line with no new number goes with what replaced it, or, for a pure removal, with the lines on both sides
  const isNew = (row: NarrowRow | undefined) => row && row.type === 'line' && row.R != null;
  rows.forEach((row, i) => {
    if (row.type !== 'line' || row.R != null) {
      return;
    }
    let next = i + 1;
    while (rows[next] && rows[next].type === 'line' && rows[next].R == null) {
      next++;
    }
    let prev = i - 1;
    while (rows[prev] && rows[prev].type === 'line' && rows[prev].R == null) {
      prev--;
    }
    const after = isNew(rows[next]) ? claimedBy[next]! : new Set<number>();
    const before = isNew(rows[prev]) ? claimedBy[prev]! : new Set<number>();
    claimedBy[i] = union(
      claimedBy[i]!,
      isNew(rows[next]) && rows[next].add ? after : union(before, after),
    );
  });
  const home = claims.home[rel];
  rows.forEach((row, i) => {
    if (row.type === 'line' && !claimedBy[i]!.size && home) {
      claimedBy[i]!.add(home);
    }
  });
  rows.forEach((row, i) => {
    if (row.type === 'line') {
      hidden[i] = claimedBy[i]!.size > 0 && !claimedBy[i]!.has(step);
    }
  });
  // a note stays, and so does the line it's on
  rows.forEach((row, i) => {
    if (row.type !== 'note') {
      return;
    }
    let j = i - 1;
    while (rows[j] && rows[j].type === 'note') {
      j--;
    }
    if (rows[j] && rows[j].type === 'line') {
      hidden[j] = false;
    }
  });
  // an info row (no newline at end of file) goes with the line before it, a hunk header with its lines when they all go
  rows.forEach((row, i) => {
    if (row.type === 'info' && i > 0 && rows[i - 1].type === 'line') {
      hidden[i] = hidden[i - 1];
    }
  });
  rows.forEach((row, i) => {
    if (row.type !== 'hunk') {
      return;
    }
    let j = i + 1;
    let any = false;
    let all = true;
    for (; rows[j] && rows[j].type !== 'hunk'; j++) {
      if (rows[j].type === 'line') {
        any = true;
        all = all && hidden[j];
      }
    }
    hidden[i] = any && all;
  });
  const runs: { from: number; to: number; steps: Set<number> }[] = [];
  let cur: { from: number; to: number; steps: Set<number> } | null = null;
  rows.forEach((row, i) => {
    if (!hidden[i]) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { from: i, to: i, steps: new Set<number>() };
      runs.push(cur);
    }
    cur.to = i;
    if (claimedBy[i]) {
      for (const claimant of claimedBy[i]) {
        cur.steps.add(claimant);
      }
    }
  });
  return {
    hidden,
    runs: runs.map((run) => ({
      ...run,
      steps: [...run.steps].sort((first, second) => first - second),
    })),
  };
}
