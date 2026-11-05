/*
 * What a chapters.json must be to be published (a plan told now; older stories are upgraded when read, legacy.ts):
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
import { chapterKeyOf } from '@once-upon-a-diff/domain/chapters';
import { REF_ID, refIdsIn } from '@once-upon-a-diff/domain/line-refs';
import { textOf } from './text-refs.ts';
import { refOf } from './chapters.ts';
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

/** A story map in a narrative, ahead of the chapter's own `### Chapter N` heading. */
function storyMapIn(narrative: string): boolean {
  const heading = /^#{1,6}\s+Chapter\s+\d+\b/m.exec(narrative);
  const before = heading ? narrative.slice(0, heading.index) : '';
  return !!before.trim() && /story map/i.test(before);
}

/**
 * The problems of a refs list, as lines: an id that is not a slug or is used twice, a path that is not one of `files`
 * (any file when `files` is not given) or not in the diff, lines that are not a range, a side that is not L or R.
 */
export function refListProblems(
  refs: PlanRef[],
  {
    files,
    diff,
    owner = 'the chapter',
  }: { files?: string[]; diff?: Map<string, DiffFile>; owner?: string } = {},
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const ref of refs) {
    const id = String(ref.id ?? '');
    if (!REF_ID.test(id)) {
      problems.push(`ref "${id}" is not an id (lower-case letters, digits and hyphens)`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`ref "${id}" is used twice`);
    }
    ids.add(id);
    const path = String(ref.path ?? '');
    if (files && !files.includes(path)) {
      problems.push(`ref "${id}" is on ${path || '(no path)'}, which ${owner} does not list`);
    } else if (!path) {
      problems.push(`ref "${id}" has no path`);
    } else if (diff && !diff.has(path)) {
      problems.push(`ref "${id}" is on ${path}, which is not in the diff`);
    }
    if (ref.start !== undefined && ref.start !== null && ref.start !== '') {
      const start = Number(ref.start);
      const end = Number(ref.end || ref.start);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        problems.push(`ref "${id}" has lines ${ref.start}-${ref.end ?? ref.start}, not a range`);
      }
      if (ref.side !== undefined && ref.side !== 'L' && ref.side !== 'R') {
        problems.push(`ref "${id}" has side "${ref.side}", which is L or R`);
      }
    }
  }
  return problems;
}

/** The problems of refs given with a text that links to them (an answer's, the overview's): bad refs, and links to ids not in the list. */
export function linkedRefProblems(
  refs: PlanRef[],
  text: string,
  where: { files?: string[]; diff?: Map<string, DiffFile>; owner?: string } = {},
): string[] {
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

/**
 * The problems of a plan, as lines naming the chapter. diff: the diff the story tells (comment paths are checked against
 * it). served: the plan already published, whose chapters may stay as they are.
 */
export function chapterProblems(
  plan: Plan,
  { diff, served }: { diff?: Map<string, DiffFile>; served?: Plan | null } = {},
): string[] {
  const problems: string[] = [];
  const chapters = plan.chapters || [];
  const overview = overviewText(plan);
  const overviewKept = !!served && overviewText(served) === overview && !Array.isArray(served.refs);
  if (overview && !Array.isArray(plan.refs) && !overviewKept) {
    problems.push(
      'the overview has no refs list: give the plan `"refs": []`, or the places its text links to',
    );
  }
  if (Array.isArray(plan.refs) || refIdsIn(overview).length) {
    problems.push(
      ...linkedRefProblems(plan.refs || [], overview, { diff }).map(
        (line) => `the overview: ${line}`,
      ),
    );
  }
  const kept = new Map(
    (served?.chapters || []).map((chapter) => [
      chapterKeyOf(chapter),
      canonical(withoutKey(chapter)),
    ]),
  );
  const byKey = new Map<string, number>();
  chapters.forEach((chapter, index) => {
    const num = index + 1;
    const key = keyText(chapter);
    if (!key) {
      problems.push(`chapter ${num} has no key`);
    } else if (byKey.has(key)) {
      problems.push(`chapters ${byKey.get(key)} and ${num} share the key "${key}"`);
    } else {
      byKey.set(key, num);
    }
    const isKept =
      !Array.isArray(chapter.refs) &&
      kept.get(chapterKeyOf(chapter)) === canonical(withoutKey(chapter));
    if (!Array.isArray(chapter.refs)) {
      if (!isKept) {
        problems.push(
          `chapter ${num} has no refs list: give it \`"refs": []\`, or the places its text links to`,
        );
      }
    } else {
      const listed = (chapter.files || []).map((entry) =>
        typeof entry === 'string' ? entry : entry.rel,
      );
      const ids = new Set(chapter.refs.map((ref) => String(ref.id ?? '')));
      problems.push(
        ...refListProblems(chapter.refs, { files: listed, diff }).map(
          (line) => `chapter ${num}: ${line}`,
        ),
      );
      const text = textOf({
        headline: chapter.headline || '',
        scenario: chapter.scenario || '',
        summary: chapter.summary || '',
        narrative: chapter.narrative || '',
      });
      for (const id of new Set(refIdsIn(text))) {
        if (!ids.has(id)) {
          problems.push(
            `chapter ${num}: the text links to ref:${id}, which the chapter does not have`,
          );
        }
      }
    }
    if (diff) {
      for (const comment of chapter.comments || []) {
        const path = String(comment.path || '');
        if (comment.carried || comment.unmapped || !path || /^\(/.test(path) || diff.has(path)) {
          continue;
        }
        problems.push(
          `chapter ${num}: the comment on ${path}:${comment.line ?? ''} needs the file's full path, as the diff names it`,
        );
      }
    }
    if (storyMapIn(String(chapter.narrative || ''))) {
      problems.push(`chapter ${num}'s narrative opens with a story map: put it in \`overview\``);
    }
  });
  return problems;
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
