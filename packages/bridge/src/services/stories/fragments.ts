/*
 * Chapters written in parallel. A story with many chapters is published as a skeleton first. Each chapter's text is then
 * written by its own writer, who hands back a fragment (never chapters.json, never a publish):
 *
 *   {"key": "…", "narrative": "…", "answer": "…", "comments": [{"path": "…", "line": 12, "body": "…"}]}
 *
 * mergeFragments lays the fragments onto the plan. A fragment fills a chapter only while that chapter has no narrative, so
 * a chapter that is written (kept by a rebuild, edited by hand, told since) is never overwritten and a second merge changes
 * nothing. Its comments go after any already there, without exact duplicates. A fragment is refused, and its chapter stays
 * unwritten, when it would not build the way the plan does: it points at a file the chapter does not list, names a file
 * that fits two of the chapter's files, moves where a file is finished, or comments on a line that is not in the diff.
 *
 * Pure: the caller reads and writes the files (skills/once-upon/bin/story.ts `merge`). `sliceOf` is the writer's packet.
 */
import { addTextRefs, ambiguousRefsOf, lineRefsOf, textOf } from './text-refs.ts';
import { chaptersOf, entryOf, type Plan, type PlanChapter } from './chapters.ts';
import { relOfPath } from './diff.ts';
import {
  chapterKeyOf,
  chapterNumbers,
  finishedInOf,
} from '@once-upon-a-diff/protocol/domain/chapters';
import type { DiffFile } from '@once-upon-a-diff/protocol/types';

/** One drafted comment in a fragment or a plan. */
type PlanComment = NonNullable<PlanChapter['comments']>[number];

/** What `merge` did with one fragment. */
export interface FragmentOutcome {
  key: string;
  status: 'merged' | 'skipped' | 'rejected';
  why: string;
}

/** Where each file is finished and the placement problems of a plan, as `build` sees them (without the hunk check). */
function placementOf(plan: Plan, rels: string[]) {
  const chapters = addTextRefs(chaptersOf(plan), rels);
  const problems: string[] = [];
  chapters.forEach((chapter, i) => {
    const own = chapter.files.map((entry) => entry.rel);
    for (const { name, rels: fits } of ambiguousRefsOf(textOf(chapter), own)) {
      problems.push(`chapter ${i + 1} names \`${name}\`, which fits ${fits.join(' and ')}`);
    }
  });
  return { finishedIn: finishedInOf(chapters), problems };
}

/** Whether a comment's line is in one of the file's hunks, on the side it names. */
function lineInDiff(file: DiffFile, line: number, side: string | undefined): boolean {
  return file.hunks.some((hunk) =>
    side === 'L'
      ? line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1)
      : line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1),
  );
}

/** The fragment's fields checked and cleaned, or the reason it is not one. */
function readFragment(raw: unknown):
  | {
      ok: true;
      key: string;
      narrative: string;
      answer: string | null;
      comments: (PlanComment & { path: string; line: number; body: string })[];
    }
  | { ok: false; key: string; why: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, key: '', why: 'not a JSON object' };
  }
  const fragment = raw as Record<string, unknown>;
  const key = typeof fragment.key === 'string' ? fragment.key.trim() : '';
  if (!key) {
    return { ok: false, key: '', why: 'has no key' };
  }
  const narrative = typeof fragment.narrative === 'string' ? fragment.narrative.trim() : '';
  if (!narrative) {
    return { ok: false, key, why: 'has no narrative' };
  }
  if (fragment.comments !== undefined && !Array.isArray(fragment.comments)) {
    return { ok: false, key, why: 'comments is not a list' };
  }
  const comments: (PlanComment & { path: string; line: number; body: string })[] = [];
  for (const item of (fragment.comments as unknown[]) || []) {
    const comment = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const body = typeof comment.body === 'string' ? comment.body.trim() : '';
    if (!body) {
      return { ok: false, key, why: 'a comment has no body' };
    }
    const path = typeof comment.path === 'string' ? comment.path.trim() : '';
    const line = Number(comment.line);
    if (path && (!Number.isInteger(line) || line < 1)) {
      return { ok: false, key, why: `the comment on ${path} has no line` };
    }
    comments.push({
      path: path || '(general)',
      line: path ? line : 0,
      body,
      ...(comment.side === 'L' ? { side: 'L' } : {}),
    });
  }
  const answer =
    typeof fragment.answer === 'string' && fragment.answer.trim() ? fragment.answer.trim() : null;
  return { ok: true, key, narrative, answer, comments };
}

/**
 * Lays each fragment on the plan, in order, and says what happened to each. Returns a new plan (the input is not changed);
 * it is the same as the input, content for content, when nothing merged.
 */
export function mergeFragments(
  plan: Plan,
  fragments: unknown[],
  diff: Map<string, DiffFile>,
): { plan: Plan; outcomes: FragmentOutcome[] } {
  const rels = [...diff.keys()];
  let current: Plan = structuredClone(plan);
  const outcomes: FragmentOutcome[] = [];
  for (const raw of fragments) {
    const fragment = readFragment(raw);
    if (!fragment.ok) {
      outcomes.push({ key: fragment.key, status: 'rejected', why: fragment.why });
      continue;
    }
    const { key } = fragment;
    const found = (current.chapters || [])
      .map((chapter, i) => (chapterKeyOf(chapter) === key ? i : -1))
      .filter((i) => i >= 0);
    if (!found.length) {
      outcomes.push({ key, status: 'rejected', why: 'no chapter has this key' });
      continue;
    }
    if (found.length > 1) {
      outcomes.push({ key, status: 'rejected', why: `${found.length} chapters share this key` });
      continue;
    }
    const target = current.chapters![found[0]];
    if (target.since) {
      outcomes.push({
        key,
        status: 'rejected',
        why: 'a "Since you read it" chapter is written in full, not merged',
      });
      continue;
    }
    if (String(target.narrative || '').trim()) {
      outcomes.push({ key, status: 'skipped', why: 'the chapter already has its text' });
      continue;
    }
    const listed = (target.files || []).map((entry) => entryOf(entry).rel);
    const refused = (why: string) => outcomes.push({ key, status: 'rejected', why });
    const outside = fragment.comments.find(
      (comment) => comment.path !== '(general)' && !relOfPath(comment.path, listed),
    );
    if (outside) {
      refused(`a comment is on ${outside.path}, which the chapter does not list`);
      continue;
    }
    const offDiff = fragment.comments.find((comment) => {
      const rel = comment.path === '(general)' ? null : relOfPath(comment.path, listed);
      const file = rel ? diff.get(rel) : null;
      return !!file && !lineInDiff(file, comment.line, comment.side);
    });
    if (offDiff) {
      refused(`the comment on ${offDiff.path}:${offDiff.line} is not on a line in the diff`);
      continue;
    }
    const before = placementOf(current, rels);
    const next: Plan = structuredClone(current);
    const chapter = next.chapters![found[0]];
    chapter.narrative = fragment.narrative;
    const existing = Array.isArray(chapter.comments) ? chapter.comments : [];
    const sideOf = (comment: { side?: string }) => (comment.side === 'L' ? 'L' : 'R');
    const sameAs = (known: PlanComment, comment: PlanComment) =>
      (known.path || '(general)') === comment.path &&
      sideOf(known) === sideOf(comment) &&
      Number(known.line || 0) === Number(comment.line || 0) &&
      String(known.body || '').trim() === String(comment.body || '').trim();
    const fresh: PlanComment[] = [];
    for (const comment of fragment.comments) {
      const mapped = {
        ...comment,
        path: comment.path === '(general)' ? comment.path : relOfPath(comment.path, listed)!,
      };
      if (![...existing, ...fresh].some((known) => sameAs(known, mapped))) {
        fresh.push(mapped);
      }
    }
    chapter.comments = [...existing, ...fresh];
    const tells = lineRefsOf(textOf(chaptersOf({ chapters: [chapter] })[0]), listed, rels).find(
      (ref) => !listed.includes(ref.rel),
    );
    if (tells) {
      refused(
        `its text points at lines of ${tells.rel}, which the chapter does not list: name that file without lines, or point at the chapter that lists it`,
      );
      continue;
    }
    const after = placementOf(next, rels);
    const ambiguous = after.problems.find((problem) => !before.problems.includes(problem));
    if (ambiguous) {
      refused(`${ambiguous}: write the full path`);
      continue;
    }
    const moved = Object.keys(after.finishedIn).find(
      (rel) => after.finishedIn[rel] !== before.finishedIn[rel],
    );
    if (moved) {
      refused(
        `it would move where ${moved} is finished (chapter ${before.finishedIn[moved]} to ${after.finishedIn[moved]})`,
      );
      continue;
    }
    if (fragment.answer) {
      chapter.answer = fragment.answer;
    }
    current = next;
    outcomes.push({
      key,
      status: 'merged',
      why: `${fragment.narrative.split(/\s+/).length} words, ${fresh.length} comments`,
    });
  }
  return { plan: current, outcomes };
}

/** A plan's per-chapter key points (points.json): what to say, and what a neighbour owns. */
export type Points = Record<string, { points?: string[]; hands_off?: string[] }>;

/** Prefixes each diff line with its line number on the side it is on: R for new and context lines, L for removed. */
function numbered(file: DiffFile, max: number): string[] {
  const out: string[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    out.push(
      `@@ old ${hunk.oldStart},${hunk.oldLines} new ${hunk.newStart},${hunk.newLines} ${hunk.header}`.trimEnd(),
    );
    for (const line of hunk.lines) {
      if (out.length >= max) {
        out.push('… more lines in this file than a chapter needs; read the rest from pr.diff');
        return out;
      }
      if (line.startsWith('-')) {
        out.push(`L${oldLine++}\t${line}`);
      } else if (line.startsWith('+')) {
        out.push(`R${newLine++}\t${line}`);
      } else if (line.startsWith(' ')) {
        out.push(`R${newLine}\t${line}`);
        oldLine++;
        newLine++;
      } else {
        out.push(`\t${line}`);
      }
    }
  }
  return out;
}

/**
 * What a chapter's writer reads: the story map, its neighbours, its key points, and the diff of the files it tells with
 * the line numbers to cite (R new side, L old side). Null when the plan has no such chapter.
 */
export function sliceOf(
  plan: Plan,
  which: string,
  diff: Map<string, DiffFile>,
  points: Points = {},
  maxLinesPerFile = 400,
): string | null {
  const chapters = plan.chapters || [];
  // numbers are the reader's: a "Since you read it" chapter is not numbered (chapterNumbers), so the rest keep theirs
  const numbers = chapterNumbers(chapters);
  const index = /^\d+$/.test(which)
    ? numbers.indexOf(Number(which))
    : chapters.findIndex((chapter) => chapterKeyOf(chapter) === which);
  const chapter = chapters[index];
  if (!chapter) {
    return null;
  }
  const key = chapterKeyOf(chapter);
  const say = (i: number) =>
    `${chapters[i].title || '(untitled)'}${chapters[i].headline ? `: ${chapters[i].headline}` : ''}`;
  // neighbours are the numbered chapters around this one
  const around = (step: number): string => {
    for (let i = index + step; i >= 0 && i < chapters.length; i += step) {
      if (numbers[i] !== null) {
        return say(i);
      }
    }
    return 'none';
  };
  const out: string[] = [
    `# Chapter to write: ${chapter.title || key}`,
    `key: ${key}`,
    `number: ${numbers[index] ?? 'none (a "Since you read it" chapter)'}`,
    `headline: ${chapter.headline || ''}`,
    `scenario: ${chapter.scenario || ''}`,
    `summary: ${chapter.summary || ''}`,
    '',
    `Previous chapter: ${around(-1)}`,
    `Next chapter: ${around(1)}`,
    '',
    '## Story map (every chapter, for what not to repeat)',
    ...chapters.map(
      (_other, i) =>
        `${numbers[i] ?? '-'}. ${say(i)}${i === index ? '  <- yours' : ''}${numbers[i] === null ? '  (not numbered)' : ''}`,
    ),
    '',
  ];
  const mine = points[key] || {};
  if (mine.points?.length) {
    out.push('## Points this chapter must make', ...mine.points.map((point) => `- ${point}`), '');
  }
  if (mine.hands_off?.length) {
    out.push(
      '## Do not re-explain (another chapter owns it)',
      ...mine.hands_off.map((point) => `- ${point}`),
      '',
    );
  }
  out.push('## Files and their diff (R = new side line, L = old side line)', '');
  for (const entry of (chapter.files || []).map(entryOf)) {
    const file = diff.get(entry.rel);
    const marks = [
      entry.partial ? `partial${entry.note ? `: ${entry.note}` : ''}` : '',
      entry.whole ? 'whole' : '',
      ...(entry.lines || []).map(
        (range) =>
          `${range.side}${range.start}-${range.end}${range.label ? ` ${range.label}` : ''}`,
      ),
    ].filter(Boolean);
    out.push(
      `### ${entry.rel}${file ? ` (${file.kind}, +${file.stats.added} -${file.stats.removed})` : ' (not in the diff)'}${marks.length ? ` [${marks.join('; ')}]` : ''}`,
    );
    if (file && !file.binary) {
      out.push(...numbered(file, maxLinesPerFile));
    }
    out.push('');
  }
  return out.join('\n');
}
