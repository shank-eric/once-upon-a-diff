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
 * (chapterProblems, uncoveredHunks) or, for placement, by the gate's own rule: a file in no chapter, a name not in the
 * diff. A partial the story never finishes is a warning, not a failure, because the gate lets it through.
 */
import { createHash } from 'node:crypto';
import type { Chapter, DiffFile } from '@once-upon-a-diff/contracts/types';
import { toSide } from '@once-upon-a-diff/terms/line-refs';
import { chaptersOf, type Plan, type PlanRef } from './chapters.ts';
import { lineInDiff } from './fragments.ts';
import { LOCKFILES, SMALL_FILE_LINES, sidesOf, uncoveredHunks } from './hunk-coverage.ts';
import { upgradePlan } from './legacy.ts';
import { lintTextRefs } from './text-refs.ts';
import { chapterProblems } from './validate.ts';

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

export interface Finding {
  level: 'fail' | 'warn';
  check: Check;
  /** the chapter's number, 1-based, when the finding is about one */
  chapter?: number;
  message: string;
}

/** The skill's own numbers. Words and refs are targets (warn); more files than filesFailOver is a step that should have been split. */
export const LIMITS = {
  wordsWarnOver: 300,
  wordsWarnUnder: 100,
  filesWarnOver: 8,
  filesFailOver: 12,
  refsWarnOver: 6,
  titleMax: 60,
  summaryMax: 240,
  answerMax: 400,
};

const fail = (check: Check, message: string, chapter?: number): Finding => ({
  level: 'fail',
  check,
  message,
  ...(chapter ? { chapter } : {}),
});
const warn = (check: Check, message: string, chapter?: number): Finding => ({
  level: 'warn',
  check,
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
  const chapters = chaptersOf(upgradePlan(plan, rels));
  const numbers = panelNumbers(chapters);
  const lastEntry = new Map<string, { partial: boolean; chapter: number | undefined }>();
  const placed = new Set<string>();
  chapters.forEach((chapter, index) => {
    for (const entry of chapter.files) {
      if (!diff.has(entry.rel)) {
        out.push(fail('placement', `${entry.rel} is not in the diff`, numbers[index]));
        continue;
      }
      placed.add(entry.rel);
      lastEntry.set(entry.rel, { partial: entry.partial, chapter: numbers[index] });
    }
  });
  const missing = rels.filter((rel) => !placed.has(rel));
  if (missing.length) {
    out.push(fail('placement', `${missing.length} files are in no chapter: ${missing.join(', ')}`));
  }
  for (const [rel, last] of lastEntry) {
    if (last.partial) {
      out.push(
        warn(
          'partials',
          `${rel} is partial in ${named(last.chapter)}, the last chapter that lists it, so no chapter finishes it`,
          last.chapter,
        ),
      );
    }
  }
  return out;
}

/**
 * Whether a ref's lines are on the page: its range overlaps a hunk's lines on the side it names, which is the rule hunk
 * coverage counts a pointer by. A ref with no lines (the whole file) always is.
 */
function refOnPage(ref: PlanRef, file: DiffFile): boolean {
  if (ref.start === undefined || ref.start === null || ref.start === '') {
    return true;
  }
  const start = Number(ref.start);
  const end = Number(ref.end || ref.start);
  const side = toSide(ref.side);
  return file.hunks.some((hunk) => {
    const lines = sidesOf(hunk)[side];
    return start <= lines.end && Math.max(start, end) >= lines.start;
  });
}

/** Every ref and comment of the story points at lines the page shows (a hunk, on the side it names). */
function pointerFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const refFindings = (refs: PlanRef[], owner: string, chapter?: number) => {
    for (const ref of refs) {
      const file = diff.get(String(ref.path ?? ''));
      if (file && !refOnPage(ref, file)) {
        const where = `${ref.path}:${ref.side === 'L' ? 'L' : ''}${ref.start}-${ref.end ?? ref.start}`;
        out.push(
          fail(
            'refs',
            `${owner}: ref "${ref.id}" (${where}) is on lines that are in no hunk`,
            chapter,
          ),
        );
      }
    }
  };
  const rels = [...diff.keys()];
  const chapters = chaptersOf(upgradePlan(plan, rels));
  const numbers = panelNumbers(chapters);
  refFindings(plan.refs || [], 'the overview');
  (plan.chapters || []).forEach((chapter, index) =>
    refFindings(chapter.refs || [], named(numbers[index]), numbers[index]),
  );
  chapters.forEach((chapter, index) => {
    for (const comment of chapter.comments) {
      const file = diff.get(comment.path);
      if (
        file &&
        !comment.carried &&
        !comment.unmapped &&
        !lineInDiff(file, Number(comment.line), comment.side)
      ) {
        out.push(
          fail(
            'comments',
            `the comment on ${comment.path}:${comment.line} is on a line that is in no hunk`,
            numbers[index],
          ),
        );
      }
    }
  });
  return out;
}

function lengthFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const chapters = chaptersOf(upgradePlan(plan, [...diff.keys()]));
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
      out.push(warn('length', `${words} words (the skill asks for about 150-300)`, num));
    } else if (words < LIMITS.wordsWarnUnder) {
      out.push(warn('length', `${words} words (the skill asks for about 150-300)`, num));
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
          warn('length', 'no refs (the skill asks for 2-4 for the hunks the text discusses)', num),
        );
      } else if (chapter.refs.length > LIMITS.refsWarnOver) {
        out.push(warn('length', `${chapter.refs.length} refs (the skill asks for 2-4)`, num));
      }
    }
  });
  return out;
}

/** The chapters as the panel numbers them: a "Since you read it" chapter has no number. */
function shapeFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const out: Finding[] = [];
  const chapters = chaptersOf(upgradePlan(plan, [...diff.keys()]));
  const numbered = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !chapter.since && !chapter.auto);
  const numbers = panelNumbers(chapters);
  numbered.forEach(({ chapter, index }, position) => {
    const num = numbers[index];
    const text = chapter.narrative.trim();
    if (!text) {
      out.push(fail('shape', 'the chapter has no narrative', num));
    } else {
      const lines = text.split('\n').map((line) => line.trim());
      const opener = /^#{1,6}\s+Chapter\s+(\d+)\s*:\s*(.*)$/i.exec(lines[0]);
      if (!opener) {
        out.push(fail('shape', 'the narrative does not open with "### Chapter N: title"', num));
      } else if (Number(opener[1]) !== position + 1) {
        out.push(
          fail(
            'shape',
            `the narrative opens as chapter ${opener[1]}, not chapter ${position + 1}`,
            num,
          ),
        );
      } else if (plainTitle(opener[2]) !== plainTitle(chapter.title)) {
        out.push(
          fail(
            'shape',
            `the narrative's heading "${opener[2].trim()}" is not the chapter's title`,
            num,
          ),
        );
      }
      const next = numbered[position + 1];
      if (next) {
        const last = lines.filter(Boolean).pop() || '';
        const closer = /^Next is chapter (\d+),\s*(.*?)\.?$/i.exec(last);
        if (!closer) {
          out.push(
            fail('shape', 'the narrative does not close with "Next is chapter N, title."', num),
          );
        } else if (Number(closer[1]) !== position + 2) {
          out.push(
            fail(
              'shape',
              `the narrative's closing line names "${last}", not the chapter that follows`,
              num,
            ),
          );
        } else if (plainTitle(closer[2]) !== plainTitle(next.chapter.title)) {
          // published stories often shorten the title while naming the right chapter, so only the number fails
          out.push(
            warn(
              'shape',
              `the narrative's closing line "${last}" does not repeat the next chapter's title`,
              num,
            ),
          );
        }
      }
    }
    if (/[.!?]\s+\S/.test(chapter.headline.trim())) {
      out.push(warn('shape', 'the headline is more than one sentence', num));
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
        ),
      );
    }
  });
  if (!plan.overview && !plan.summary && !plan.plan) {
    out.push(warn('shape', 'the story has no overview'));
  }
  if ((plan.title || '').length > LIMITS.titleMax) {
    out.push(
      warn('shape', `the title is ${plan.title!.length} characters (at most ${LIMITS.titleMax})`),
    );
  }
  if ((plan.summary || '').length > LIMITS.summaryMax) {
    out.push(
      warn(
        'shape',
        `the summary is ${plan.summary!.length} characters (at most ${LIMITS.summaryMax})`,
      ),
    );
  }
  return out;
}

/** Everything wrong or worth a look in a story, fails first. */
export function storyFindings(plan: Plan, diff: Map<string, DiffFile>): Finding[] {
  const rels = [...diff.keys()];
  const chapters = chaptersOf(upgradePlan(plan, rels));
  const findings: Finding[] = [
    ...placementFindings(plan, diff),
    ...uncoveredHunks(chapters, diff).map((file) =>
      fail(
        'hunks',
        `${file.rel}: no chapter points at ${file.hunks.map((hunk) => hunk.ref).join(', ')}`,
      ),
    ),
    ...chapterProblems(plan, { diff }).map((line) => fail('plan', line)),
    ...pointerFindings(plan, diff),
    ...lengthFindings(plan, diff),
    ...shapeFindings(plan, diff),
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
