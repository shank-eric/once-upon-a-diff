/*
 * Text that looks like a reference, which no longer links anything. A chapter's narrative links to a place by id
 * (`[text](ref:<id>)`, to an entry of the chapter's `refs`), never by a file name or a line in backticks. Two things read
 * the old forms: legacy.ts, which upgrades a story told before refs, and lintTextRefs here, which warns an author whose
 * new narrative still writes `` `path:45` `` or `` `name.ts` `` where a link was meant.
 */
import { parseLineRef } from '@once-upon-a-diff/domain/line-refs';
import type { Chapter } from '@once-upon-a-diff/protocol/types';
import type { Plan } from './chapters.ts';

/** The file a name is (an exact path), else every file it is a path suffix of. */
export const findIn = (name: string, scope: string[]): string | string[] =>
  scope.find((rel) => rel === name) || scope.filter((rel) => rel.endsWith('/' + name));

/** Whether a backticked word could be a file name: no spaces, and a dot or a slash. */
export const mayBeFile = (name: string) => !!name && !/\s/.test(name) && /[./]/.test(name);

/** The text of a chapter the panel draws as markdown. */
export const textOf = (
  chapter: Pick<Chapter, 'headline' | 'scenario' | 'summary' | 'narrative'>,
): string =>
  [chapter.headline, chapter.scenario, chapter.summary, chapter.narrative]
    .filter(Boolean)
    .join('\n\n');

/**
 * Warnings for the backticks in a plan's chapter text that name one of the chapter's files or point at lines
 * (`path:45`, `:45`) and are not inside a ref link: they draw as plain code. One line per chapter and mention.
 */
export function lintTextRefs(plan: Plan): string[] {
  const warnings: string[] = [];
  (plan.chapters || []).forEach((chapter, i) => {
    const listed = (chapter.files || []).map((entry) =>
      typeof entry === 'string' ? entry : entry.rel,
    );
    const seen = new Set<string>();
    const src = textOf({
      headline: chapter.headline || '',
      scenario: chapter.scenario || '',
      summary: chapter.summary || '',
      narrative: chapter.narrative || '',
    })
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[[^\]]*\]\(ref:[^)\s]*\)/g, ' '); // a ref link's text is a link already
    for (const match of src.matchAll(/`([^`\n]+)`/g)) {
      const { name, line } = parseLineRef(match[1]);
      const names =
        mayBeFile(name) &&
        (typeof findIn(name, listed) === 'string' || (findIn(name, listed) as string[]).length > 0);
      if ((names || (line && (!name || mayBeFile(name)))) && !seen.has(match[1])) {
        seen.add(match[1]);
        warnings.push(
          `chapter ${i + 1}: \`${match[1]}\` is text, not a link: add a ref and write [text](ref:<id>)`,
        );
      }
    }
  });
  return warnings;
}
