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

/**
 * {steps, home}: steps[step - 1] is {rel -> [{side, start, end}] | null}, the ranges each step gives each file
 * (null for "the whole file"), and home[rel] the step that shows the lines no range covers.
 */
export function claimsOf(chapters) {
  const home = {};
  (chapters || []).forEach((ch, i) => {
    if (!ch.since) {
      for (const f of ch.files || []) {
        if (!(f.rel in home)) {
          home[f.rel] = i + 1;
        }
      }
    }
  });
  const steps = (chapters || []).map((ch) => {
    const out = {};
    for (const f of ch.files || []) {
      const ls = (f.lines || []).filter((l) => l && Number.isFinite(+l.start));
      out[f.rel] = ls.length
        ? ls.map((l) => ({
            side: l.side === 'L' ? 'L' : 'R',
            start: +l.start,
            end: +(l.end || l.start),
          }))
        : null;
    }
    return out;
  });
  return { steps, home };
}

/** The steps (1-based) whose ranges for rel cover side:num. */
function stepsAt(claims, rel, side, num) {
  const out = new Set();
  if (num == null) {
    return out;
  }
  claims.steps.forEach((byRel, i) => {
    const rs = byRel[rel];
    if (rs && rs.some((r) => r.side === side && num >= r.start && num <= r.end)) {
      out.add(i + 1);
    }
  });
  return out;
}
const union = (...sets) => new Set(sets.flatMap((s) => [...s]));

/**
 * rows: [{type: 'hunk'} | {type: 'line', L, R, add} | {type: 'note'} | {type: 'info'}] in table order,
 * L and R being the row's old and new line numbers (null when it has none) and add whether its new side is an added line.
 * Returns {hidden: [bool per row], runs: [{from, to, steps: [step]}]}: the runs of hidden rows, each to fold behind one row,
 * with the steps that tell them. Nothing is hidden when step n lists rel without ranges, or doesn't list it.
 */
export function narrowRows(rows, claims, rel, n) {
  const hidden = rows.map(() => false);
  const own = claims.steps[n - 1] && claims.steps[n - 1][rel];
  if (!own) {
    return { hidden, runs: [] };
  }
  // each line row's claiming steps: by its new line, and by its old line
  const at = rows.map((r) =>
    r.type === 'line'
      ? union(stepsAt(claims, rel, 'R', r.R), stepsAt(claims, rel, 'L', r.L))
      : null,
  );
  // a removed line with no new number goes with what replaced it, or, for a pure removal, with the lines on both sides
  const isNew = (r) => r && r.type === 'line' && r.R != null;
  rows.forEach((r, i) => {
    if (r.type !== 'line' || r.R != null) {
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
    const after = isNew(rows[next]) ? at[next] : new Set();
    const before = isNew(rows[prev]) ? at[prev] : new Set();
    at[i] = union(at[i], isNew(rows[next]) && rows[next].add ? after : union(before, after));
  });
  const home = claims.home[rel];
  rows.forEach((r, i) => {
    if (r.type === 'line' && !at[i].size && home) {
      at[i].add(home);
    }
  });
  rows.forEach((r, i) => {
    if (r.type === 'line') {
      hidden[i] = at[i].size > 0 && !at[i].has(n);
    }
  });
  // a note stays, and so does the line it's on
  rows.forEach((r, i) => {
    if (r.type !== 'note') {
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
  rows.forEach((r, i) => {
    if (r.type === 'info' && i > 0 && rows[i - 1].type === 'line') {
      hidden[i] = hidden[i - 1];
    }
  });
  rows.forEach((r, i) => {
    if (r.type !== 'hunk') {
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
  const runs = [];
  let cur = null;
  rows.forEach((r, i) => {
    if (!hidden[i]) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { from: i, to: i, steps: new Set() };
      runs.push(cur);
    }
    cur.to = i;
    if (at[i]) {
      for (const s of at[i]) {
        cur.steps.add(s);
      }
    }
  });
  return { hidden, runs: runs.map((x) => ({ ...x, steps: [...x.steps].sort((a, b) => a - b) })) };
}
