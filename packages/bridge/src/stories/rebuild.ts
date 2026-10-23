/*
 * Rebuilding a story the reviewer already has: the panel's "Rebuild story"
 * (mode 'rebuild', the whole story re-told on the current diff) and "Rebuild
 * from here" (mode 'rebuild_from' with from_step N: chapters 1..N-1 stay
 * exactly as published, N and later are re-told).
 *
 * The story keeps its id and URL. When the new chapters.json is published
 * (`once-upon publish` for a PR, `once-upon local --chapters` for a local
 * story) while a rebuild request is pending:
 *   - rebuildProblems() refuses it when a kept chapter changed, a file of the
 *     diff has no chapter, or a hunk isn't covered (the whole story's coverage,
 *     not only the re-told part)
 *   - carryDrafts() keeps every drafted comment of the re-told chapters the new
 *     ones dropped: a draft whose line is still in the diff moves to the chapter
 *     that now tells that line or file (`carried`), and one whose line isn't is
 *     kept and flagged (`unmapped`), so nothing is dropped silently
 *   - questionMoves() points each question asked on a re-told chapter at the
 *     chapter that now tells its file (or the Overview), and retireReads() sets
 *     aside a read of a chapter whose files changed in the rebuild
 */
import { chaptersOf, entryOf } from './chapters.ts';
import { readReads, retireReads } from './reads.ts';
import { chapterKeyOf } from '@once-upon-a-diff/shared/panel/story-model';
import { plural } from '@once-upon-a-diff/shared/util/text';
import { Inbox } from '../inbox/inbox.ts';
import { moveQuestions } from '../inbox/conversation.ts';
import { addTextRefs } from './text-refs.ts';
import { uncoveredHunks, sidesOf } from './hunk-coverage.ts';
import { relOfPath } from '../util/diff.ts';
import type { DiffFile } from '@once-upon-a-diff/shared/types';
import type { Plan, PlanChapter } from './chapters.ts';

/** What a rebuild's rules read of its request. */
type RebuildAskFields = { mode?: string; from_step?: number | null };
type PlanComment = NonNullable<PlanChapter['comments']>[number];

export const REBUILD_MODES = ['rebuild', 'rebuild_from'];
export const isRebuild = (build: { mode?: string } | null | undefined): boolean =>
  !!build && REBUILD_MODES.includes(build.mode as string);

/** The first step a rebuild re-tells: from_step for rebuild_from, 1 for a whole rebuild. */
export const firstRetold = (build: RebuildAskFields | null | undefined): number =>
  build && build.mode === 'rebuild_from' && Number(build.from_step) > 1
    ? Number(build.from_step)
    : 1;

/** JSON with sorted keys, so two chapters compare by content whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The kept chapters (1..from-1) that the new plan changed or lost: problem lines. */
function keptChapterProblems(before: Plan, after: Plan, from: number): string[] {
  const problems: string[] = [];
  const old = (before.chapters || []).slice(0, from - 1);
  const now = after.chapters || [];
  old.forEach((chapter, i) => {
    if (!now[i]) {
      problems.push(`chapter ${i + 1} is gone; chapters 1-${from - 1} must stay as published`);
    } else if (canonical(chapter) !== canonical(now[i])) {
      problems.push(
        `chapter ${i + 1} ("${chapter.title || ''}") changed; chapters 1-${from - 1} must stay exactly as published (copy them from the published chapters.json)`,
      );
    }
  });
  if (now.length < from) {
    problems.push(
      `there's no chapter ${from}: a rebuild from chapter ${from} re-tells it and what follows`,
    );
  }
  return problems;
}

/** Placement and hunk coverage over the whole story: problem lines. */
function coverageProblems(
  after: Plan,
  diff: Map<string, DiffFile>,
  { allowUncovered = false } = {},
): string[] {
  const rels = [...diff.keys()];
  const chapters = addTextRefs(chaptersOf(after), rels);
  const problems: string[] = [];
  const placed = new Set<string>();
  chapters.forEach((chapter, i) => {
    for (const entry of chapter.files) {
      if (!diff.has(entry.rel)) {
        problems.push(`chapter ${i + 1} names ${entry.rel}, which is not in the diff`);
      } else {
        placed.add(entry.rel);
      }
    }
  });
  const missing = rels.filter((rel) => !placed.has(rel));
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  const uncovered = allowUncovered ? [] : uncoveredHunks(chapters, diff);
  if (uncovered.length) {
    const refs = uncovered.flatMap((file) => file.hunks.map((hunk) => hunk.ref));
    problems.push(`hunks not covered: ${refs.join(', ')} (--allow-uncovered publishes anyway)`);
  }
  return problems;
}

/**
 * Why a rebuild can't be published as it is: [] when it can. build is the pending request ({mode, from_step}), before
 * chapters.json as published before the rebuild, after the new one, and diff the diff the story tells now.
 */
export function rebuildProblems(
  build: RebuildAskFields,
  before: Plan,
  after: Plan,
  diff: Map<string, DiffFile>,
  { allowUncovered = false } = {},
): string[] {
  const from = firstRetold(build);
  return [
    ...(from > 1 ? keptChapterProblems(before, after, from) : []),
    ...coverageProblems(after, diff, { allowUncovered }),
  ];
}

const isGeneral = (comment: PlanComment) =>
  !(Number(comment.line) > 0) || /^\(/.test(comment.path || '');
const commentId = (comment: PlanComment) =>
  `${comment.path || ''}\n${Number(comment.line) || 0}\n${String(comment.body || '').trim()}`;

/** Is the comment's line inside one of the file's hunks (context included), on its side? */
function onDiffLine(file: DiffFile, comment: PlanComment): boolean {
  const side = comment.side === 'L' ? 'L' : 'R';
  const line = Number(comment.line);
  return file.hunks.some((hunk) => {
    const range = sidesOf(hunk)[side];
    return line >= range.start && line <= range.end;
  });
}

/** The re-told chapter a comment belongs in now: index into after.chapters. */
function homeOf(
  after: Plan,
  from: number,
  oldKey: string,
  rel: string | null,
  comment: PlanComment,
): number {
  const retold = (after.chapters as PlanChapter[])
    .map((chapter, index) => ({ chapter, index }))
    .slice(from - 1);
  type Retold = (typeof retold)[number];
  const entriesOf = ({ chapter }: Retold) => (chapter.files || []).map(entryOf);
  const lists = (candidate: Retold) =>
    !!rel && entriesOf(candidate).some((entry) => entry.rel === rel);
  const sameKey = retold.find(({ chapter }) => chapterKeyOf(chapter) === oldKey);
  if (sameKey && (!rel || lists(sameKey))) {
    return sameKey.index;
  }
  if (rel && !isGeneral(comment)) {
    const line = Number(comment.line);
    const side = comment.side === 'L' ? 'L' : 'R';
    const byLines = retold.find((candidate) =>
      entriesOf(candidate).some(
        (entry) =>
          entry.rel === rel &&
          (entry.lines || []).some(
            (range) => range.side === side && line >= range.start && line <= range.end,
          ),
      ),
    );
    if (byLines) {
      return byLines.index;
    }
  }
  const listing = retold.find(lists);
  if (listing) {
    return listing.index;
  }
  return (sameKey || retold[0]).index;
}

/**
 * Keeps the drafts of the re-told chapters (from `from` on) that the new chapters dropped. Changes `after` in place.
 * A general draft, or a line draft whose line is still in the diff, is `carried` to the chapter that tells it now;
 * a line draft whose file or line has left the diff is kept too, `unmapped`, for the reviewer to check.
 */
export function carryDrafts(
  before: Plan,
  after: Plan,
  diff: Map<string, DiffFile>,
  from = 1,
): { carried: number; unmapped: number } {
  const rels = [...diff.keys()];
  const present = new Set(
    (after.chapters || []).flatMap((chapter) => (chapter.comments || []).map(commentId)),
  );
  const counts = { carried: 0, unmapped: 0 };
  if (!(after.chapters || []).length || (after.chapters as PlanChapter[]).length < from) {
    return counts;
  }
  for (const chapter of (before.chapters || []).slice(from - 1)) {
    for (const comment of chapter.comments || []) {
      const id = commentId(comment);
      if (present.has(id)) {
        continue;
      }
      present.add(id);
      const rel = isGeneral(comment) ? null : relOfPath(comment.path, rels);
      const maps = isGeneral(comment) || (!!rel && onDiffLine(diff.get(rel) as DiffFile, comment));
      const target = (after.chapters as PlanChapter[])[
        homeOf(after, from, chapterKeyOf(chapter), rel, comment)
      ];
      target.comments = Array.isArray(target.comments) ? target.comments : [];
      const { carried, unmapped, ...draft } = comment;
      target.comments.push({ ...draft, ...(maps ? { carried: true } : { unmapped: true }) });
      counts[maps ? 'carried' : 'unmapped'] += 1;
    }
  }
  return counts;
}

/**
 * Where each question asked on a re-told chapter shows now: {<question id>: step}, 0 for the Overview (which shows
 * every question). The chapter with the same key while it still lists the question's file, else the first re-told
 * one that does, else the one with the same key.
 */
export function questionMoves(
  questions: { id: string; step: number | null; file: string | null }[],
  before: Plan,
  after: Plan,
  from = 1,
): Record<string, number> {
  const moves: Record<string, number> = {};
  const rels = (chapter: PlanChapter) => (chapter.files || []).map((entry) => entryOf(entry).rel);
  const now = (after.chapters || []).map((chapter, index) => ({ chapter, step: index + 1 }));
  for (const question of questions) {
    const step = Number(question.step);
    if (!(step >= from)) {
      continue;
    }
    const old = (before.chapters || [])[step - 1];
    const sameKey = old && now.find(({ chapter }) => chapterKeyOf(chapter) === chapterKeyOf(old));
    const tellsFile = ({ chapter }: { chapter: PlanChapter }) =>
      rels(chapter).some(
        (rel) => rel === question.file || String(question.file).endsWith('/' + rel),
      );
    const file = question.file ? now.slice(from - 1).find(tellsFile) : null;
    // the same chapter while it still tells the question's file, else the one that does
    const keep = sameKey && (!question.file || tellsFile(sameKey)) ? sameKey : null;
    const target = (keep || file || sameKey || { step: 0 }).step;
    if (target !== step) {
      moves[question.id] = target;
    }
  }
  return moves;
}

/**
 * The read records to set aside: the keys of chapters the rebuild re-told with a different set of files. A chapter
 * kept as it was, or re-told over the same files, keeps its read.
 */
export function readsToRetire(reads: Record<string, unknown>, before: Plan, after: Plan): string[] {
  const filesOf = (chapter: PlanChapter) =>
    (chapter.files || [])
      .map((entry) => entryOf(entry).rel)
      .sort()
      .join('\n');
  const old = new Map((before.chapters || []).map((chapter) => [chapterKeyOf(chapter), chapter]));
  return (after.chapters || [])
    .filter((chapter) => {
      const key = chapterKeyOf(chapter);
      return reads[key] && (!old.has(key) || filesOf(old.get(key)!) !== filesOf(chapter));
    })
    .map(chapterKeyOf);
}

/** One line on what a rebuild kept, for the request's note and the panel. */
export function rebuildNote(
  build: RebuildAskFields,
  { carried = 0, unmapped = 0, moved = 0, retired = 0 } = {},
): string {
  const from = firstRetold(build);
  const what = from > 1 ? `Re-told from chapter ${from}` : 'Re-told the whole story';
  const parts = [
    carried ? `kept ${plural(carried, 'draft')}` : '',
    unmapped ? `flagged ${plural(unmapped, 'draft')} whose line left the diff` : '',
    moved ? `moved ${plural(moved, 'question')}` : '',
    retired ? `${plural(retired, 'chapter')} to read again` : '',
  ].filter(Boolean);
  return parts.length ? `${what}: ${parts.join(', ')}.` : `${what}.`;
}

/**
 * Before a rebuild is published: refuses it (throws, with every problem) unless it keeps what it must and tells the
 * whole diff, then carries the dropped drafts into `after`. Returns the counts for afterRebuild.
 */
export function vetRebuild(
  build: RebuildAskFields,
  before: Plan,
  after: Plan,
  diff: Map<string, DiffFile>,
  { allowUncovered = false } = {},
): { carried: number; unmapped: number } {
  const problems = rebuildProblems(build, before, after, diff, { allowUncovered });
  if (problems.length) {
    throw new Error(`this rebuild can't be published:\n  - ${problems.join('\n  - ')}`);
  }
  return carryDrafts(before, after, diff, firstRetold(build));
}

/**
 * Once a rebuild is published: moves the questions asked on re-told chapters and sets aside the reads of chapters
 * re-told over other files. `stateKey` is where the story's read.json lives (stateKeyOf). Returns rebuildNote's line.
 */
export function afterRebuild(
  home: string,
  {
    id,
    stateKey,
    build,
    before,
    after,
    counts,
  }: {
    id: string;
    stateKey: string;
    build: RebuildAskFields;
    before: Plan;
    after: Plan;
    counts: { carried: number; unmapped: number };
  },
): string {
  const from = firstRetold(build);
  const moves = questionMoves(new Inbox(home).questions(id), before, after, from);
  moveQuestions(home, id, moves);
  const retired = retireReads(
    home,
    stateKey,
    readsToRetire(readReads(home, stateKey), before, after),
  );
  return rebuildNote(build, { ...counts, moved: Object.keys(moves).length, retired });
}
