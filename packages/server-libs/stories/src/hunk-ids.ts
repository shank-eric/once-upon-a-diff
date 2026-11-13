/*
 * Hunk ids: every hunk of a diff has one, `h1`, `h2`, ... in diff order across all its files (binary files and files with
 * no hunks have none). `story.ts brief` lists them, and a plan chapter says `"hunks": ["h7", "h8"]` instead of typing a
 * ref object for each: expandHunks turns the ids into refs on the hunk's own lines, which cover it (hunk-coverage.ts).
 *
 * Ids are against the story's diff (pr.diff, or a local story's local.diff), never the display variant (local-w.diff).
 * Once expanded the refs are plain data, so a later diff that shifts the ids cannot re-point them.
 */
import type { DiffFile, DiffHunk } from '@once-upon-a-diff/contracts/types';
import type { Side } from '@once-upon-a-diff/terms/line-refs';
import { sidesOf } from './hunk-coverage.ts';
import type { Plan, PlanChapter, PlanFile, PlanRef } from './chapters.ts';

export interface HunkEntry {
  id: string;
  rel: string;
  hunk: DiffHunk;
  /** the side a ref on it points at: R, or L for a hunk that only removes lines (as hunkRef does) */
  side: Side;
  start: number;
  end: number;
}

/** The hunks of a diff with their ids, in diff order. */
export function hunkIdsOf(diff: Map<string, DiffFile>): HunkEntry[] {
  const out: HunkEntry[] = [];
  for (const file of diff.values()) {
    if (file.binary) {
      continue;
    }
    for (const hunk of file.hunks) {
      const side: Side = hunk.lines.every((line) => !line.startsWith('+')) ? 'L' : 'R';
      const { start, end } = sidesOf(hunk)[side];
      out.push({ id: `h${out.length + 1}`, rel: file.rel, hunk, side, start, end });
    }
  }
  return out;
}

const relOfEntry = (entry: PlanFile) => (typeof entry === 'string' ? entry : entry.rel);

/** The label of a ref made from a hunk: the function its `@@` line names, else the file and lines. */
function labelOf(entry: HunkEntry): string {
  const name = entry.rel.split('/').pop();
  return entry.hunk.header || `${name} ${entry.start}-${entry.end}`;
}

/**
 * Turns each chapter's `hunks` ids into refs (id = the hunk id, so the text can link `ref:h7`), then drops `hunks`.
 * Changes the plan in place. A plan with no `hunks` is left as it is. Problems, one line each: an id not in the diff, a
 * hunk in a file the chapter does not list (placement stays the plan's call). A ref already named like the hunk is
 * replaced by the hunk's own, wherever the old one points.
 */
export function expandHunks(
  plan: Plan,
  diff: Map<string, DiffFile>,
): { expanded: number; changed: boolean; problems: string[] } {
  const entries = hunkIdsOf(diff);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const problems: string[] = [];
  let expanded = 0;
  let changed = false; // a chapter had `hunks`, so the plan differs from the file it came from even when no ref was made
  (plan.chapters || []).forEach((chapter: PlanChapter, index) => {
    if (chapter.hunks === undefined) {
      return;
    }
    changed = true;
    const where = `chapter ${index + 1}`;
    const ids = Array.isArray(chapter.hunks) ? chapter.hunks.map(String) : [];
    if (!Array.isArray(chapter.hunks)) {
      problems.push(`${where}: "hunks" is a list of hunk ids like ["h1", "h2"]`);
    }
    const listed = (chapter.files || []).map(relOfEntry);
    const refs = chapter.refs || [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        problems.push(
          `${where}: hunk ${id} is not in the diff (it has ${entries.length ? `h1-h${entries.length}` : 'no hunks'})`,
        );
      } else if (!listed.includes(entry.rel)) {
        problems.push(`${where}: hunk ${id} is in ${entry.rel}, which the chapter does not list`);
      } else {
        const ref: PlanRef = {
          id,
          path: entry.rel,
          side: entry.side,
          start: entry.start,
          end: entry.end,
          label: labelOf(entry),
          hunk: true, // the chapter listed the hunk by id, which counts as linking it (hunk-coverage.ts)
        };
        // an old ref with the hunk's id (a leftover of an earlier telling) is replaced by the hunk's own
        const old = refs.findIndex((other) => other.id === id);
        if (old < 0) {
          refs.push(ref);
        } else {
          refs[old] = ref;
        }
        expanded++;
      }
    }
    chapter.refs = refs;
    delete chapter.hunks;
  });
  return { expanded, changed, problems };
}

/** expandHunks for a publisher: refuses the plan, with every problem, as readyPlan does. Returns how many refs it made and whether the plan changed (write it back). */
export function expandHunksForPublish(
  plan: Plan,
  diff: Map<string, DiffFile>,
): { expanded: number; changed: boolean } {
  const { expanded, changed, problems } = expandHunks(plan, diff);
  if (problems.length) {
    throw new Error(`chapters.json can't be published:\n  - ${problems.join('\n  - ')}`);
  }
  return { expanded, changed };
}
