/*
 * What a chapters.json must be to be published (a plan told now; older stories are upgraded when read, legacy.ts):
 *
 *   key       every chapter has one, unique in the story. The bridge assigns it when a chapter has none (assignKeys), from
 *             its title as the panel always derived it, and the author keeps it from then on.
 *   refs      every chapter has a `refs` list (an empty one is fine): [{id, path, side, start, end, label}], each on a
 *             file the chapter lists. The text links to one as `[text](ref:<id>)`, and only a ref id links anything.
 *   comments  a drafted comment's `path` is the file's full path in the diff.
 *   overview  the story map belongs in `overview`, never ahead of a chapter's own heading.
 *
 * chapterProblems lists what is wrong, one line each. A chapter with no `refs` that is exactly the one already published
 * (a rebuild keeps chapters 1..N-1 byte for byte) is accepted: it is read as an older story's.
 */
import { chapterKeyOf } from '@once-upon-a-diff/protocol/domain/chapters';
import { REF_ID, refIdsIn } from '@once-upon-a-diff/protocol/domain/line-refs';
import { textOf } from './text-refs.ts';
import type { DiffFile } from '@once-upon-a-diff/protocol/types';
import type { Plan, PlanChapter } from './chapters.ts';

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

export const withoutKey = ({ key: _key, ...rest }: PlanChapter) => rest;

/** A story map in a narrative, ahead of the chapter's own `### Chapter N` heading. */
function storyMapIn(narrative: string): boolean {
  const heading = /^#{1,6}\s+Chapter\s+\d+\b/m.exec(narrative);
  const before = heading ? narrative.slice(0, heading.index) : '';
  return !!before.trim() && /story map/i.test(before);
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
      const ids = new Set<string>();
      for (const ref of chapter.refs) {
        const id = String(ref.id ?? '');
        if (!REF_ID.test(id)) {
          problems.push(
            `chapter ${num}: ref "${id}" is not an id (lower-case letters, digits and hyphens)`,
          );
          continue;
        }
        if (ids.has(id)) {
          problems.push(`chapter ${num}: ref "${id}" is used twice`);
        }
        ids.add(id);
        const path = String(ref.path ?? '');
        if (!listed.includes(path)) {
          problems.push(
            `chapter ${num}: ref "${id}" is on ${path || '(no path)'}, which the chapter does not list`,
          );
        } else if (diff && !diff.has(path)) {
          problems.push(`chapter ${num}: ref "${id}" is on ${path}, which is not in the diff`);
        }
        if (ref.start !== undefined && ref.start !== null && ref.start !== '') {
          const start = Number(ref.start);
          const end = Number(ref.end || ref.start);
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
            problems.push(
              `chapter ${num}: ref "${id}" has lines ${ref.start}-${ref.end ?? ref.start}, not a range`,
            );
          }
          if (ref.side !== undefined && ref.side !== 'L' && ref.side !== 'R') {
            problems.push(`chapter ${num}: ref "${id}" has side "${ref.side}", which is L or R`);
          }
        }
      }
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
