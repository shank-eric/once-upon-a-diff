/*
 * Chapters written in parallel. A story with many chapters is published as a skeleton first. Each chapter's text is then
 * written by its own writer, who hands back a fragment (never chapters.json, never a publish):
 *
 *   {"key": "…", "narrative": "…", "answer": "…", "refs": [{"id": "load", "path": "…", "side": "R", "start": 40, "end": 58}],
 *    "comments": [{"path": "…", "line": 12, "body": "…"}]}
 *
 * mergeFragments lays the fragments onto the plan. A fragment fills a chapter only while that chapter has no narrative, so
 * a chapter that is written (kept by a rebuild, edited by hand, told since) is never overwritten and a second merge changes
 * nothing. Its refs join the chapter's (a ref with an id the chapter has is skipped when it is the same, refused when it is
 * not), and its comments go after any already there, without exact duplicates. A fragment is refused, and its chapter stays
 * unwritten, when it would not build the way the plan does (validate.ts chapterProblems): a ref or comment on a file the
 * chapter does not list, a comment without the file's full path or on a line that is not in the diff, or a link to a ref
 * the chapter does not have.
 *
 * Pure: the caller reads and writes the files (skills/once-upon/bin/story.ts `merge`). `sliceOf` is the writer's packet.
 */
import { entryOf, refOf, type Plan, type PlanChapter, type PlanRef } from './chapters.ts';
import { chapterProblems } from './validate.ts';
import { chapterKeyOf, chapterNumbers } from '@once-upon-a-diff/domain/chapters';
import type { DiffFile } from '@once-upon-a-diff/protocol/types';
import { toSide } from '@once-upon-a-diff/domain/line-refs';

/** Where a ref points, as text: its file and lines (or the file), never its label. */
function placeOf(ref: PlanRef): string {
  const { path, side, start, end } = refOf(ref);
  return start === undefined ? path : `${path} ${side}${start}-${end}`;
}

/** One drafted comment in a fragment or a plan. */
type PlanComment = NonNullable<PlanChapter['comments']>[number];

/** What `merge` did with one fragment. */
export interface FragmentOutcome {
  key: string;
  status: 'merged' | 'skipped' | 'rejected';
  why: string;
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
      refs: PlanRef[];
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
  if (fragment.refs !== undefined && !Array.isArray(fragment.refs)) {
    return { ok: false, key, why: 'refs is not a list' };
  }
  const refs = ((fragment.refs as unknown[]) || []).map((item) =>
    item && typeof item === 'object' ? (item as PlanRef) : ({} as PlanRef),
  );
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
  return { ok: true, key, narrative, answer, refs, comments };
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
      (comment) => comment.path !== '(general)' && !listed.includes(comment.path),
    );
    if (outside) {
      refused(
        `a comment is on ${outside.path}, which the chapter does not list (write the file's full path)`,
      );
      continue;
    }
    const offDiff = fragment.comments.find((comment) => {
      const file = comment.path === '(general)' ? null : diff.get(comment.path);
      return !!file && !lineInDiff(file, comment.line, comment.side);
    });
    if (offDiff) {
      refused(`the comment on ${offDiff.path}:${offDiff.line} is not on a line in the diff`);
      continue;
    }
    const next: Plan = structuredClone(current);
    const chapter = next.chapters![found[0]];
    chapter.narrative = fragment.narrative;
    const existing = Array.isArray(chapter.comments) ? chapter.comments : [];
    const sideOf = (comment: { side?: string }) => toSide(comment.side);
    const sameAs = (known: PlanComment, comment: PlanComment) =>
      (known.path || '(general)') === comment.path &&
      sideOf(known) === sideOf(comment) &&
      Number(known.line || 0) === Number(comment.line || 0) &&
      String(known.body || '').trim() === String(comment.body || '').trim();
    const fresh: PlanComment[] = [];
    for (const comment of fragment.comments) {
      if (![...existing, ...fresh].some((known) => sameAs(known, comment))) {
        fresh.push(comment);
      }
    }
    chapter.comments = [...existing, ...fresh];
    const refs = Array.isArray(chapter.refs) ? [...chapter.refs] : [];
    let clash: string | null = null;
    for (const ref of fragment.refs) {
      const known = refs.find((one) => one.id === ref.id);
      if (!known) {
        refs.push(ref);
      } else if (placeOf(known) !== placeOf(ref)) {
        // the same id and place is the planned ref again (its label may differ or be left out): the chapter's stays
        clash = `ref "${String(ref.id)}" is already in the chapter on ${placeOf(known)}, and the fragment has it on ${placeOf(ref)}`;
      }
    }
    chapter.refs = refs;
    const problem = clash || chapterProblems({ chapters: [{ ...chapter, key }] }, { diff })[0];
    if (problem) {
      refused(problem.replace(/^chapter 1: /, ''));
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
  const refs = (chapter.refs || []).map(refOf);
  out.push(
    '## Refs this chapter has (link to one as [text](ref:<id>); add the ones you need to your fragment)',
    ...(refs.length
      ? refs.map(
          (ref) =>
            `- ${ref.id}: ${ref.path}${ref.start !== undefined ? ` ${ref.side}${ref.start}-${ref.end}` : ''}${ref.label ? ` ${ref.label}` : ''}`,
        )
      : ['(none yet)']),
    '',
  );
  out.push('## Files and their diff (R = new side line, L = old side line)', '');
  for (const entry of (chapter.files || []).map(entryOf)) {
    const file = diff.get(entry.rel);
    const marks = [
      entry.partial ? `partial${entry.note ? `: ${entry.note}` : ''}` : '',
      entry.whole ? 'whole' : '',
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
