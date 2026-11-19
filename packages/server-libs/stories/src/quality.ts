/*
 * How good a built story is, as checks over its chapters.json and the diff it tells (the story evals, packages/server-libs/stories/scripts).
 * Pure: it reads a plan and a parsed diff and returns findings, so `yarn test` runs it over recorded stories and the eval
 * runner runs it over a fresh model telling.
 *
 * Two levels. `fail` is something the panel or the reviewer would trip over: a file or hunk no chapter tells, a ref that
 * points where the page has no lines, a chapter that does not open or close as the skill says, far too many files in one
 * journey step. `warn` is a measure the skill gives as a target (≈300 words, ≈8 files, 2-4 refs): reported, never failing.
 *
 * What the build gate (skills/once-upon/bin/story.ts) already refuses is checked here again by the same functions
 * (chapterProblems, uncoveredHunks, unfinishedPartials) or, for placement, by the gate's own rule: a file in no
 * chapter, a name not in the diff.
 */
import { createHash } from 'node:crypto';
import type { Chapter, DiffFile } from '@once-upon-a-diff/contracts/types';
import { chaptersOf, type Plan, type PlanRef } from './chapters.ts';
import { offPageComments, offPageRefs } from './pointers.ts';
import { partialMessage, unfinishedPartials } from './gate.ts';
import {
  BIG_HUNK_LINES,
  LOCKFILES,
  SMALL_FILE_LINES,
  WHOLE_WARN_LINES,
  thinHunks,
  uncoveredHunks,
} from './hunk-coverage.ts';
import { lintTextRefs } from './text-refs.ts';
import { chapterProblems, keptChapters } from './validate.ts';
import { expandHunks } from './hunk-ids.ts';

export type Check =
  | 'placement'
  | 'partials'
  | 'hunks'
  | 'plan'
  | 'refs'
  | 'comments'
  | 'length'
  | 'files'
  | 'shape'
  | 'links';

/**
 * What a length or shape finding is, for the fix that suits it (story-report.ts): one rule covers findings that need
 * different fixes, so the rule alone does not say what to do.
 */
export type Kind =
  | 'unwritten'
  | 'too-long'
  | 'too-short'
  | 'no-refs'
  | 'too-many-refs'
  | 'no-opener'
  | 'opener-number'
  | 'opener-title'
  | 'no-closer'
  | 'closer-number'
  | 'closer-title'
  | 'headline'
  | 'answer'
  | 'no-overview'
  | 'title-long'
  | 'summary-long'
  | 'thin-whole'
  | 'thin-hunk';

export interface Finding {
  level: 'fail' | 'warn';
  check: Check;
  /** what the finding is, on the length and shape rules */
  kind?: Kind;
  /** the chapter's number, 1-based, when the finding is about one */
  chapter?: number;
  message: string;
}

/** The finding for a chapter still being written: a skeleton has it on every chapter, so a publish's summary leaves it out. */
const NO_NARRATIVE = 'the chapter has no narrative';

/** The skill's own numbers. Words and refs are targets (warn); more files than filesFailOver is a step that should have been split. */
const LIMITS = {
  wordsWarnOver: 300,
  wordsWarnUnder: 100,
  filesWarnOver: 8,
  filesFailOver: 12,
  refsWarnOver: 6,
  titleMax: 60,
  summaryMax: 240,
  answerMax: 400,
};

const fail = (check: Check, message: string, chapter?: number, kind?: Kind): Finding => ({
  level: 'fail',
  check,
  ...(kind ? { kind } : {}),
  message,
  ...(chapter ? { chapter } : {}),
});
const warn = (check: Check, message: string, chapter?: number, kind?: Kind): Finding => ({
  level: 'warn',
  check,
  ...(kind ? { kind } : {}),
  message,
  ...(chapter ? { chapter } : {}),
});

/** Words of a chapter's narrative, as a reader counts them: a ref link counts its text, not its target. */
export function wordCount(narrative: string): number {
  return (narrative.replace(/\]\(ref:[^)\s]*\)/g, ']').match(/\S+/g) || []).length;
}

const withoutNumber = (title: string) =>
  title
    .replace(/^\s*chapter\s+\d+\s*[:.–—-]\s*/i, '')
    .trim()
    .toLowerCase();

/** A title as a heading or a closer is compared with it: no "Chapter N:", no inline-code backticks, one case and spacing. */
const plainTitle = (title: string) => withoutNumber(title.replace(/`/g, '')).replace(/\s+/g, ' ');

/** The number the panel shows for each chapter, which findings use: a "Since you read it" or leftover chapter has none. */
function panelNumbers(chapters: Chapter[]): (number | undefined)[] {
  let next = 0;
  return chapters.map((chapter) => (chapter.since || chapter.auto ? undefined : ++next));
}

const named = (num: number | undefined) =>
  num ? `chapter ${num}` : 'a "Since you read it" chapter';

/** Where each chapter's files, parts and numbers stand: placement, partials. */
function placementFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const rels = [...diff.keys()];
  const chapters = chaptersOf(plan);
  const numbers = panelNumbers(chapters);
  const placed = new Set<string>();
  chapters.forEach((chapter, index) => {
    for (const entry of chapter.files) {
      if (!diff.has(entry.rel)) {
        out.push(fail('placement', `${entry.rel} is not in the diff`, numbers[index]));
        continue;
      }
      placed.add(entry.rel);
    }
  });
  const missing = rels.filter((rel) => !placed.has(rel));
  if (missing.length) {
    out.push(fail('placement', `${missing.length} files are in no chapter: ${missing.join(', ')}`));
  }
  for (const { rel, index } of unfinishedPartials(chapters, diff)) {
    out.push(fail('partials', partialMessage(rel, named(numbers[index])), numbers[index]));
  }
  return out;
}

/** Every ref and comment of the story points at lines the page shows (a hunk, on the side it names). */
function pointerFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const refFindings = (refs: PlanRef[], owner: string, chapter?: number) => {
    for (const line of offPageRefs(refs, diff)) {
      out.push(fail('refs', `${owner}: ${line}`, chapter));
    }
  };
  const chapters = chaptersOf(plan);
  const numbers = panelNumbers(chapters);
  refFindings(plan.refs || [], 'the overview');
  (plan.chapters || []).forEach((chapter, index) =>
    refFindings(chapter.refs || [], named(numbers[index]), numbers[index]),
  );
  chapters.forEach((chapter, index) => {
    for (const place of offPageComments(chapter.comments, diff)) {
      out.push(
        fail('comments', `the comment on ${place} is on a line that is in no hunk`, numbers[index]),
      );
    }
  });
  return out;
}

function lengthFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const chapters = chaptersOf(plan);
  const journey = (plan.mode || 'journey') !== 'chronological';
  const numbers = panelNumbers(chapters);
  chapters.forEach((chapter, index) => {
    const num = numbers[index];
    if (chapter.auto) {
      return;
    }
    const words = wordCount(chapter.narrative);
    if (!words) {
      // no narrative is a shape failure, not a length
    } else if (words > LIMITS.wordsWarnOver) {
      out.push(
        warn('length', `${words} words (the skill asks for about 150-300)`, num, 'too-long'),
      );
    } else if (words < LIMITS.wordsWarnUnder) {
      out.push(
        warn('length', `${words} words (the skill asks for about 150-300)`, num, 'too-short'),
      );
    }
    // the skill's exemptions: only a journey step splits by size; a "Since you read it" chapter lists every file of its commits;
    // a `whole` file, a lockfile and a deleted file cost the reader little
    if (journey && !chapter.since) {
      // SKILL.md has no exemption for a sweep of small files, but published stories have them (one mechanical change over
      // dozens of small files), and hunk coverage already treats a file of SMALL_FILE_LINES or fewer as told by being
      // listed: so only the bigger files can fail the step, and a long list of small ones is a warning
      const counted = chapter.files
        .filter((entry) => {
          const file = diff.get(entry.rel);
          return !entry.whole && !LOCKFILES.test(entry.rel) && file?.kind !== 'deleted';
        })
        .map((entry) => diff.get(entry.rel))
        .filter((file): file is DiffFile => !!file);
      const big = counted.filter(
        (file) => file.stats.added + file.stats.removed > SMALL_FILE_LINES,
      ).length;
      if (big > LIMITS.filesFailOver) {
        out.push(
          fail(
            'files',
            `${big} files over ${SMALL_FILE_LINES} changed lines in one step (split it past ${LIMITS.filesFailOver})`,
            num,
          ),
        );
      } else if (counted.length > LIMITS.filesWarnOver) {
        out.push(
          warn(
            'files',
            `${counted.length} files in one step, ${counted.length - big} of them small (${SMALL_FILE_LINES} changed lines or fewer); the skill says to split past about ${LIMITS.filesWarnOver}`,
            num,
          ),
        );
      }
    }
    if (!chapter.since) {
      if (chapter.refs.length === 0 && chapter.files.length) {
        out.push(
          warn(
            'length',
            'no refs (the skill asks for 2-4 for the hunks the text discusses)',
            num,
            'no-refs',
          ),
        );
      } else if (chapter.refs.length > LIMITS.refsWarnOver) {
        out.push(
          warn(
            'length',
            `${chapter.refs.length} refs (the skill asks for 2-4)`,
            num,
            'too-many-refs',
          ),
        );
      }
    }
  });
  return out;
}

/** The chapters as the panel numbers them: a "Since you read it" chapter has no number. */
function shapeFindings(plan: Plan): Finding[] {
  const out: Finding[] = [];
  const chapters = chaptersOf(plan);
  const numbered = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !chapter.since && !chapter.auto);
  const numbers = panelNumbers(chapters);
  numbered.forEach(({ chapter, index }, position) => {
    const num = numbers[index];
    const text = chapter.narrative.trim();
    if (!text) {
      out.push(fail('shape', NO_NARRATIVE, num, 'unwritten'));
    } else {
      const lines = text.split('\n').map((line) => line.trim());
      const opener = /^#{1,6}\s+Chapter\s+(\d+)\s*:\s*(.*)$/i.exec(lines[0]);
      if (!opener) {
        out.push(
          fail(
            'shape',
            'the narrative does not open with "### Chapter N: title"',
            num,
            'no-opener',
          ),
        );
      } else if (Number(opener[1]) !== position + 1) {
        out.push(
          fail(
            'shape',
            `the narrative opens as chapter ${opener[1]}, not chapter ${position + 1}`,
            num,
            'opener-number',
          ),
        );
      } else if (plainTitle(opener[2]) !== plainTitle(chapter.title)) {
        out.push(
          fail(
            'shape',
            `the narrative's heading "${opener[2].trim()}" is not the chapter's title`,
            num,
            'opener-title',
          ),
        );
      }
      const next = numbered[position + 1];
      if (next) {
        const last = lines.filter(Boolean).pop() || '';
        const closer = /^Next is chapter (\d+),\s*(.*?)\.?$/i.exec(last);
        if (!closer) {
          out.push(
            fail(
              'shape',
              'the narrative does not close with "Next is chapter N, title."',
              num,
              'no-closer',
            ),
          );
        } else if (Number(closer[1]) !== position + 2) {
          out.push(
            fail(
              'shape',
              `the narrative's closing line names "${last}", not the chapter that follows`,
              num,
              'closer-number',
            ),
          );
        } else if (plainTitle(closer[2]) !== plainTitle(next.chapter.title)) {
          // published stories often shorten the title while naming the right chapter, so only the number fails
          out.push(
            warn(
              'shape',
              `the narrative's closing line "${last}" does not repeat the next chapter's title`,
              num,
              'closer-title',
            ),
          );
        }
      }
    }
    if (/[.!?]\s+\S/.test(chapter.headline.trim())) {
      out.push(warn('shape', 'the headline is more than one sentence', num, 'headline'));
    }
  });
  const plain = plan.chapters || [];
  plain.forEach((chapter, index) => {
    if (typeof chapter.answer === 'string' && chapter.answer.length > LIMITS.answerMax) {
      out.push(
        warn(
          'shape',
          `the answer is ${chapter.answer.length} characters (at most ${LIMITS.answerMax})`,
          numbers[index],
          'answer',
        ),
      );
    }
  });
  if (!plan.overview && !plan.summary && !plan.plan) {
    out.push(warn('shape', 'the story has no overview', undefined, 'no-overview'));
  }
  if ((plan.title || '').length > LIMITS.titleMax) {
    out.push(
      warn(
        'shape',
        `the title is ${plan.title!.length} characters (at most ${LIMITS.titleMax})`,
        undefined,
        'title-long',
      ),
    );
  }
  if ((plan.summary || '').length > LIMITS.summaryMax) {
    out.push(
      warn(
        'shape',
        `the summary is ${plan.summary!.length} characters (at most ${LIMITS.summaryMax})`,
        undefined,
        'summary-long',
      ),
    );
  }
  return out;
}

/**
 * Everything wrong or worth a look in a story, fails first. served: the plan already published, whose unchanged (kept)
 * chapters count every ref and are left alone by the chapter rules, as a rebuild's vet does.
 */
export function storyFindings(
  given: Plan,
  diff: Map<string, DiffFile>,
  served?: Plan | null,
): Finding[] {
  // a chapter's `hunks` ids are read as the refs they become at build (a copy: this only reads)
  const plan = structuredClone(given);
  const hunked = expandHunks(plan, diff);
  const chapters = chaptersOf(plan);
  const kept = keptChapters(plan, served);
  const findings: Finding[] = [
    ...placementFindings(plan, diff),
    ...uncoveredHunks(chapters, diff, { linked: true, kept }).map((file) =>
      fail(
        'hunks',
        `${file.rel}: no chapter points at ${file.hunks.map((hunk) => hunk.ref).join(', ')} (a ref counts when the chapter's text links it: [text](ref:id))`,
      ),
    ),
    ...thinHunks(chapters, diff, { linked: true, kept }).map((place) =>
      place.kind === 'whole'
        ? warn(
            'hunks',
            `${place.rel} is told whole in one chapter though it has ${place.lines} changed lines (over ${WHOLE_WARN_LINES})`,
            undefined,
            'thin-whole',
          )
        : warn(
            'hunks',
            `${place.ref} is ${place.lines} lines and the chapter's refs cover ${place.covered} of them (under a tenth; hunks of ${BIG_HUNK_LINES}+ lines need refs across them)`,
            undefined,
            'thin-hunk',
          ),
    ),
    ...hunked.problems.map((line) => fail('plan', line)),
    ...chapterProblems(plan, { diff, served, pointers: false }).map((line) => fail('plan', line)),
    ...pointerFindings(plan, diff),
    ...lengthFindings(plan, diff),
    ...shapeFindings(plan),
    ...lintTextRefs(plan).map((line) => warn('links', line)),
  ];
  return [
    ...findings.filter((finding) => finding.level === 'fail'),
    ...findings.filter((finding) => finding.level === 'warn'),
  ];
}

/**
 * The story rules the eval sends the model: SKILL.md's step 2 (plan chapters) and "How the story sounds". Throws when a
 * heading was renamed and a slice came back empty, so the eval never runs on a prompt with the rules missing.
 */
export function storyRulesOf(skill: string): string {
  const between = (from: RegExp, until: RegExp) => {
    const start = from.exec(skill);
    const end = start ? until.exec(skill.slice(start.index + 1)) : null;
    return start && end ? skill.slice(start.index, start.index + 1 + end.index).trim() : '';
  };
  const plan = between(
    /^2\. \*\*Plan chapters\.\*\*/m,
    /^3\. \*\*Build and publish the skeleton\.\*\*/m,
  );
  const voice = between(/^## How the story sounds/m, /^## Voice mode/m);
  if (!plan) {
    throw new Error('SKILL.md: no step 2 ("2. **Plan chapters.**" up to step 3) to send the model');
  }
  if (!voice) {
    throw new Error(
      'SKILL.md: no "## How the story sounds" section (up to "## Voice mode") to send the model',
    );
  }
  return `${plan}\n\n${voice}\n`;
}

/** What a recorded story says it was told under: a hash of the rules the model got, so a rules edit shows as stale. */
export const rulesHash = (skill: string): string =>
  createHash('sha256').update(storyRulesOf(skill)).digest('hex').slice(0, 16);
