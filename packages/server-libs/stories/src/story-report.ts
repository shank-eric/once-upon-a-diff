/*
 * The quality findings (quality.ts) as lines a storyteller reads, for `story.mjs check`, the findings summary `story.mjs
 * build` and `once-upon local` print after they publish, and the local story's own folder. Pure but for reading the folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from './diff.ts';
import { storyFindings, type Check, type Finding, type Kind } from './quality.ts';
import type { Plan } from './chapters.ts';

/** What would fix a finding, by the rule it broke, for the rules whose findings all have the one fix. */
const RULE_FIX: Partial<Record<Check, string>> = {
  placement: 'list the file in a chapter, or drop a name the diff does not have',
  partials: 'finish the file in a later chapter, or list it whole',
  hunks:
    'add a ref on the hunk to the chapter that tells it and link it in the text, or mark the file "whole": true',
  plan: 'fix what the line says in chapters.json',
  refs: 'point the ref at lines inside a hunk, on the side it names',
  comments: 'move the comment to a line inside a hunk',
  files: 'split the step so fewer files share it',
  links: 'link the mention as [text](ref:<id>) instead of a path:line',
};

/** What would fix a length or shape finding, by what it is: the rule alone does not say. */
const KIND_FIX: Record<Kind, string> = {
  unwritten: 'write the chapter',
  'too-long': 'trim or split the chapter toward the skill target',
  'too-short': "say more about what the chapter's hunks do, toward the skill target",
  'no-refs': 'add 2-4 refs for the hunks the chapter discusses',
  'too-many-refs': 'keep the 2-4 refs the text leans on',
  'no-opener': 'open with "### Chapter N: title"',
  'opener-number': "number the heading as the chapter's place in the story",
  'opener-title': "make the heading's title the chapter's title",
  'no-closer': 'close with "Next is chapter N, title."',
  'closer-number': 'name the chapter that follows in the closing line',
  'closer-title': "repeat the next chapter's title in the closing line",
  headline: 'cut the headline to one sentence',
  answer: 'shorten the answer',
  'no-overview': "write the story's overview",
  'title-long': 'shorten the title',
  'summary-long': 'shorten the summary',
  'thin-whole': 'split the file across chapters, or point refs at the parts that matter',
  'thin-hunk': "add refs across the hunk's parts, one for each thing it does",
};

/** The fix for a finding, or none where the finding does not say what to do. */
function fixOf(finding: Finding): string | undefined {
  return finding.kind ? KIND_FIX[finding.kind] : RULE_FIX[finding.check];
}

/** One finding on one line: level, rule, chapter, what it is about, and what would fix it (when that is certain). */
export function findingLine(finding: Finding): string {
  const where = finding.chapter ? `chapter ${finding.chapter}` : 'story';
  const fix = fixOf(finding);
  return `${finding.level} ${finding.check} ${where}: ${finding.message}${fix ? ` (fix: ${fix})` : ''}`;
}

/**
 * The findings of a story told so far. A chapter with no narrative is still being written (the skill publishes chapter by
 * chapter), so it is counted apart and the narrative rules (length, shape) skip it; `final` is the last check of a telling,
 * where an unwritten chapter is a fail like any other.
 */
function settleFindings(all: Finding[], final = false): { findings: Finding[]; writing: number } {
  if (final) {
    return { findings: all, writing: 0 };
  }
  const unwritten = new Set(
    all.filter((finding) => finding.kind === 'unwritten').map((finding) => finding.chapter),
  );
  return {
    findings: all.filter(
      (finding) =>
        !(
          finding.kind === 'unwritten' ||
          ((finding.check === 'length' || finding.check === 'shape') &&
            unwritten.has(finding.chapter))
        ),
    ),
    writing: unwritten.size,
  };
}

const stillWriting = (writing: number): string =>
  `${writing} chapter${writing === 1 ? '' : 's'} still being written`;

/** The whole report of `check`: every finding (or a "no findings" line), then the chapters still being written. */
export function findingsReport(all: Finding[], final = false): string[] {
  const { findings, writing } = settleFindings(all, final);
  return [
    ...(findings.length ? findings.map(findingLine) : ['Story checks: no findings']),
    ...(writing ? [`${stillWriting(writing)} (story.mjs check --final fails them)`] : []),
  ];
}

/** Whether `check` exits 1: a fail in what `findingsReport` lists. */
export function hasFails(all: Finding[], final = false): boolean {
  return settleFindings(all, final).findings.some((finding) => finding.level === 'fail');
}

/**
 * The short form `build` and `local` print: the counts, then the fail lines. A chapter still being written is counted
 * apart, not failed, so a skeleton's publish does not list every chapter as a failure. It never throws: a plan the
 * rules cannot read gives one line saying so, because it runs after the publish and cannot change the exit status.
 */
export function findingsSummary(compute: () => Finding[]): string[] {
  try {
    const { findings, writing } = settleFindings(compute());
    const fails = findings.filter((finding) => finding.level === 'fail');
    const warns = findings.length - fails.length;
    const counts = [
      `${fails.length} fail${fails.length === 1 ? '' : 's'}`,
      `${warns} warn${warns === 1 ? '' : 's'}`,
      ...(writing ? [stillWriting(writing)] : []),
    ];
    return [
      `Story checks: ${counts.join(', ')}${findings.length ? ' (story.mjs check lists them)' : ''}`,
      ...fails.map(findingLine),
    ];
  } catch (error) {
    return [`findings: could not be computed: ${(error as Error).message}`];
  }
}

/** The findings of the story published in `dir`: its chapters.json over its local.diff (a local story's own diff). */
export function localStoryFindings(dir: string): Finding[] {
  const chapters = path.join(dir, 'chapters.json');
  const diff = path.join(dir, 'local.diff');
  if (!existsSync(chapters) || !existsSync(diff)) {
    return [];
  }
  return storyFindings(
    JSON.parse(readFileSync(chapters, 'utf8')) as Plan,
    parseUnifiedDiff(readFileSync(diff, 'utf8')),
  );
}
