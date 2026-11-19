/*
 * What a chapters.json must be to be published (a plan told now):
 *
 *   key       every chapter has one, unique in the story. The bridge assigns it when a chapter has none (assignKeys), from
 *             its title as the panel always derived it, and the author keeps it from then on.
 *   refs      every chapter has a `refs` list (an empty one is fine): [{id, path, side, start, end, label}], each on a
 *             file the chapter lists. The text links to one as `[text](ref:<id>)`, and only a ref id links anything.
 *   comments  a drafted comment's `path` is the file's full path in the diff.
 *   overview  the story map belongs in `overview`, never ahead of a chapter's own heading. The overview, summary and plan
 *             link by the plan's own `refs`, which may be on any file of the story.
 *
 * chapterProblems lists what is wrong, one line each. A chapter with no `refs` that is exactly the one already published
 * (a rebuild keeps chapters 1..N-1 byte for byte) is accepted: it is read as an older story's.
 */
import { chapterKeyOf } from '@once-upon-a-diff/terms/chapters';
import { REF_ID, refIdsIn } from '@once-upon-a-diff/terms/line-refs';
import { textOf } from './text-refs.ts';
import { refOf } from './chapters.ts';
import { offPageComments, offPageRefs } from './pointers.ts';
import type { ChapterRef, DiffFile } from '@once-upon-a-diff/contracts/types';
import type { Plan, PlanChapter, PlanRef } from './chapters.ts';

/** JSON with sorted keys, so two chapters compare by content whatever order their keys were written in. */
export function canonical(value: unknown): string {
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

const keyText = (chapter: PlanChapter) =>
  typeof chapter.key === 'string' ? chapter.key.trim().slice(0, 200) : '';

/**
 * Gives every chapter with no key one: its title without "Chapter N:", lower-cased (what the panel has always used, so
 * what a reviewer read stays read), numbered " 2", " 3" when another chapter has it, `chapter-N` with no title.
 * Changes the plan in place and returns the keys it set.
 */
export function assignKeys(plan: Plan): string[] {
  const chapters = plan.chapters || [];
  const taken = new Set(chapters.map(keyText).filter(Boolean));
  const set: string[] = [];
  chapters.forEach((chapter, index) => {
    if (keyText(chapter)) {
      return;
    }
    const base = chapterKeyOf({ title: chapter.title }) || `chapter-${index + 1}`;
    let key = base;
    for (let copy = 2; taken.has(key); copy++) {
      key = `${base} ${copy}`;
    }
    taken.add(key);
    chapter.key = key;
    set.push(key);
  });
  return set;
}

/** The plan's own text, which links by the plan's `refs`: its overview, summary and plan. */
const overviewText = (plan: Plan) =>
  [plan.overview, plan.summary, plan.plan].filter(Boolean).join('\n\n');

export const withoutKey = ({ key: _key, ...rest }: PlanChapter) => rest;

/**
 * Which of the plan's chapters are kept: exactly the served chapter of the same key, key aside. A kept chapter is text
 * nobody touched in this telling, so a rule added since it was written does not apply to it.
 */
export function keptChapters(plan: Plan, served?: Plan | null): boolean[] {
  const before = new Map(
    (served?.chapters || []).map((chapter) => [
      chapterKeyOf(chapter),
      canonical(withoutKey(chapter)),
    ]),
  );
  return (plan.chapters || []).map(
    (chapter) => before.get(chapterKeyOf(chapter)) === canonical(withoutKey(chapter)),
  );
}

/** A story map in a narrative, ahead of the chapter's own `### Chapter N` heading. */
function storyMapIn(narrative: string): boolean {
  const heading = /^#{1,6}\s+Chapter\s+\d+\b/m.exec(narrative);
  const before = heading ? narrative.slice(0, heading.index) : '';
  return !!before.trim() && /story map/i.test(before);
}

type RefWhere = { files?: string[]; diff?: Map<string, DiffFile>; owner?: string };

/** Why a ref's path is not good (not one of `files`, none, or not in the diff), or null. */
function refPathProblem(
  id: string,
  path: string,
  { files, diff, owner = 'the chapter' }: RefWhere,
): string | null {
  if (files && !files.includes(path)) {
    return `ref "${id}" is on ${path || '(no path)'}, which ${owner} does not list`;
  }
  if (!path) {
    return `ref "${id}" has no path`;
  }
  return diff && !diff.has(path) ? `ref "${id}" is on ${path}, which is not in the diff` : null;
}

/** Whether a ref names lines at all: `start` is set. */
const hasLines = (ref: PlanRef): boolean =>
  ref.start !== undefined && ref.start !== null && ref.start !== '';

/** Whether lines `start` to `end` are a range of whole numbers from line 1 up. */
const isLineRange = (start: number, end: number): boolean =>
  Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start;

/** The problems of a ref's lines (a range of whole numbers) and side (L or R); a ref with no `start` has neither. */
function refLinesProblems(id: string, ref: PlanRef): string[] {
  if (!hasLines(ref)) {
    return [];
  }
  const badRange = !isLineRange(Number(ref.start), Number(ref.end || ref.start));
  const badSide = ref.side !== undefined && ref.side !== 'L' && ref.side !== 'R';
  return [
    badRange ? `ref "${id}" has lines ${ref.start}-${ref.end ?? ref.start}, not a range` : null,
    badSide ? `ref "${id}" has side "${ref.side}", which is L or R` : null,
  ].filter((line): line is string => line !== null);
}

/** The problems of one ref; `ids` holds the ids the refs before it used, and takes this one. */
function refProblems(ref: PlanRef, ids: Set<string>, where: RefWhere): string[] {
  const id = String(ref.id ?? '');
  if (!REF_ID.test(id)) {
    return [`ref "${id}" is not an id (lower-case letters, digits and hyphens)`];
  }
  const usedTwice = ids.has(id) ? [`ref "${id}" is used twice`] : [];
  ids.add(id);
  const path = refPathProblem(id, String(ref.path ?? ''), where);
  return [...usedTwice, ...(path ? [path] : []), ...refLinesProblems(id, ref)];
}

/**
 * The problems of a refs list, as lines: an id that is not a slug or is used twice, a path that is not one of `files`
 * (any file when `files` is not given) or not in the diff, lines that are not a range, a side that is not L or R.
 */
function refListProblems(refs: PlanRef[], where: RefWhere = {}): string[] {
  const ids = new Set<string>();
  return refs.flatMap((ref) => refProblems(ref, ids, where));
}

/** The problems of refs given with a text that links to them (an answer's, the overview's): bad refs, and links to ids not in the list. */
function linkedRefProblems(refs: PlanRef[], text: string, where: RefWhere = {}): string[] {
  const ids = new Set(refs.map((ref) => String(ref.id ?? '')));
  return [
    ...refListProblems(refs, where),
    ...[...new Set(refIdsIn(text))]
      .filter((id) => !ids.has(id))
      .map((id) => `the text links to ref:${id}, which has no ref`),
  ];
}

/**
 * The refs an answer's text links to, from the JSON a `--refs` file holds: checked like a chapter's, and each `ref:<id>`
 * in `text` must be one of them. Throws with every problem. files: the
 * story's files, which a ref's path must be one of (the full path as the diff has it).
 */
export function answerRefs(raw: unknown, text: string, files?: string[]): ChapterRef[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      'the refs file must hold a JSON list: [{"id": "load", "path": "src/a.js", "start": 40, "end": 58}]',
    );
  }
  const problems = linkedRefProblems(raw as PlanRef[], text, { files, owner: 'the story' });
  if (problems.length) {
    throw new Error(`refs:\n  - ${problems.join('\n  - ')}`);
  }
  return raw.map((ref) => refOf(ref as PlanRef));
}

type PlanRefsOpts = { diff?: Map<string, DiffFile>; served?: Plan | null; pointers?: boolean };

const prefixed = (prefix: string, lines: string[]): string[] =>
  lines.map((line) => `${prefix}: ${line}`);

/** Whether the served plan has this overview text and refs, so this telling did not touch them. */
const overviewUnchanged = (plan: Plan, served?: Plan | null): boolean =>
  !!served &&
  overviewText(served) === overviewText(plan) &&
  canonical(served.refs) === canonical(plan.refs);

/** Whether the served plan has this overview text and no refs list, so the overview is kept as it was written. */
const overviewKeptWithoutList = (plan: Plan, served?: Plan | null): boolean =>
  !!served && overviewText(served) === overviewText(plan) && !Array.isArray(served.refs);

/** A plan whose overview text links to places needs a refs list, unless the served plan has the same overview. */
const overviewListProblems = (plan: Plan, served?: Plan | null): string[] =>
  overviewText(plan) && !Array.isArray(plan.refs) && !overviewKeptWithoutList(plan, served)
    ? ['the overview has no refs list: give the plan `"refs": []`, or the places its text links to']
    : [];

/** The problems of the overview's refs and of its links to them, when it has a list or links. */
const overviewLinkProblems = (plan: Plan, diff?: Map<string, DiffFile>): string[] => {
  const overview = overviewText(plan);
  return Array.isArray(plan.refs) || refIdsIn(overview).length
    ? prefixed('the overview', linkedRefProblems(plan.refs || [], overview, { diff }))
    : [];
};

/** The problems of the plan's own text and refs (the overview). */
function overviewProblems(plan: Plan, { diff, served, pointers = true }: PlanRefsOpts): string[] {
  const placesChecked = !!diff && pointers && !overviewUnchanged(plan, served);
  return [
    ...overviewListProblems(plan, served),
    ...overviewLinkProblems(plan, diff),
    ...(placesChecked ? prefixed('the overview', offPageRefs(plan.refs || [], diff!)) : []),
  ];
}

/** The problem with a chapter's key (none, or one an earlier chapter has), or null; `byKey` takes a good key. */
function keyProblem(chapter: PlanChapter, num: number, byKey: Map<string, number>): string | null {
  const key = keyText(chapter);
  if (!key) {
    return `chapter ${num} has no key`;
  }
  if (byKey.has(key)) {
    return `chapters ${byKey.get(key)} and ${num} share the key "${key}"`;
  }
  byKey.set(key, num);
  return null;
}

/** The ids a chapter's text links to (`ref:<id>`) that its refs do not have, as lines. */
function unlistedLinkProblems(chapter: PlanChapter, num: number, refs: PlanRef[]): string[] {
  const ids = new Set(refs.map((ref) => String(ref.id ?? '')));
  const text = textOf({
    headline: chapter.headline || '',
    scenario: chapter.scenario || '',
    summary: chapter.summary || '',
    narrative: chapter.narrative || '',
  });
  return [...new Set(refIdsIn(text))]
    .filter((id) => !ids.has(id))
    .map((id) => `chapter ${num}: the text links to ref:${id}, which the chapter does not have`);
}

/** The problems of a chapter's refs: the list itself (unless the chapter is kept as served), its places, and the text's links. A kept chapter's places are not checked against the diff. */
function chapterRefsProblems(
  chapter: PlanChapter,
  num: number,
  isKept: boolean,
  { diff, pointers = true }: PlanRefsOpts,
): string[] {
  const refs = chapter.refs;
  if (!Array.isArray(refs)) {
    return isKept
      ? []
      : [
          `chapter ${num} has no refs list: give it \`"refs": []\`, or the places its text links to`,
        ];
  }
  const listed = (chapter.files || []).map((entry) =>
    typeof entry === 'string' ? entry : entry.rel,
  );
  return [
    ...prefixed(`chapter ${num}`, refListProblems(refs, { files: listed, diff })),
    ...(diff && pointers && !isKept ? prefixed(`chapter ${num}`, offPageRefs(refs, diff)) : []),
    ...unlistedLinkProblems(chapter, num, refs),
  ];
}

/** Why a comment's path is not one the diff names (the comment says it is a real, mapped one), or null. */
function commentPathProblem(
  comment: NonNullable<PlanChapter['comments']>[number],
  num: number,
  diff: Map<string, DiffFile>,
): string | null {
  const path = String(comment.path || '');
  const hasNoRealPath = !path || /^\(/.test(path);
  if (comment.carried || comment.unmapped || hasNoRealPath || diff.has(path)) {
    return null;
  }
  return `chapter ${num}: the comment on ${path}:${comment.line ?? ''} needs the file's full path, as the diff names it`;
}

/** The problems of a chapter's comments: on lines in no hunk (not for a kept chapter), and on a path the diff does not name. */
function chapterCommentProblems(
  chapter: PlanChapter,
  num: number,
  isKept: boolean,
  { diff, pointers = true }: PlanRefsOpts,
): string[] {
  if (!diff) {
    return [];
  }
  const comments = chapter.comments || [];
  const offPage =
    pointers && !isKept
      ? offPageComments(comments, diff).map(
          (place) => `chapter ${num}: the comment on ${place} is on a line that is in no hunk`,
        )
      : [];
  const badPaths = comments.map((comment) => commentPathProblem(comment, num, diff));
  return [...offPage, ...badPaths.filter((line): line is string => line !== null)];
}

/**
 * The problems of a plan, as lines naming the chapter. diff: the diff the story tells (comment paths are checked against
 * it). served: the plan already published, whose chapters may stay as they are. pointers: whether a ref or a comment on lines
 * in no hunk is a problem (not for a chapter equal to the served one); the story check reports those itself, so it asks for none.
 */
export function chapterProblems(plan: Plan, opts: PlanRefsOpts = {}): string[] {
  const kept = keptChapters(plan, opts.served);
  const byKey = new Map<string, number>();
  const perChapter = (plan.chapters || []).flatMap((chapter, index) => {
    const num = index + 1;
    const key = keyProblem(chapter, num, byKey);
    const isKept = kept[index] ?? false;
    return [
      ...(key ? [key] : []),
      ...chapterRefsProblems(chapter, num, isKept, opts),
      ...chapterCommentProblems(chapter, num, isKept, opts),
      ...(storyMapIn(String(chapter.narrative || ''))
        ? [`chapter ${num}'s narrative opens with a story map: put it in \`overview\``]
        : []),
    ];
  });
  return [...overviewProblems(plan, opts), ...perChapter];
}

/**
 * Readies a plan for publishing: gives its chapters their keys (assignKeys) and refuses it, with every problem, unless
 * chapterProblems finds none. Returns the keys it assigned, so the caller can write them back to the author's file.
 */
export function readyPlan(
  plan: Plan,
  opts: { diff?: Map<string, DiffFile>; served?: Plan | null } = {},
): string[] {
  const assigned = assignKeys(plan);
  const problems = chapterProblems(plan, opts);
  if (problems.length) {
    throw new Error(`chapters.json can't be published:\n  - ${problems.join('\n  - ')}`);
  }
  return assigned;
}
