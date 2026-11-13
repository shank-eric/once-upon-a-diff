import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { parseUnifiedDiff } from '../src/diff.ts';
import type { Plan, PlanChapter } from '../src/chapters.ts';
import { mergeFragments } from '../src/fragments.ts';
import { chaptersOf } from '../src/chapters.ts';
import { expandHunks } from '../src/hunk-ids.ts';
import { thinHunks, uncoveredHunks } from '../src/hunk-coverage.ts';
import { rebuildProblems } from '../src/rebuild.ts';
import { storyFindings } from '../src/quality.ts';
import { unfinishedPartials } from '../src/gate.ts';
import { chapterProblems } from '../src/validate.ts';

/** A modified file's diff with one hunk per [newStart, added] pair, a line of context on either side. */
function modified(rel: string, hunks: [number, number][]): string[] {
  const out = [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`];
  for (const [start, added] of hunks) {
    out.push(`@@ -${start},2 +${start},${added + 2} @@ fn`, ' before');
    for (let i = 0; i < added; i++) {
      out.push(`+line ${start + 1 + i}`);
    }
    out.push(' after');
  }
  return out;
}

// src/a.js has one hunk, new lines 10-13 (the ones the page shows)
const diff = parseUnifiedDiff([...modified('src/a.js', [[10, 2]]), ''].join('\n'));

const chapter = (extra: Partial<PlanChapter> = {}): PlanChapter => ({
  key: 'a',
  title: 'Chapter 1: A',
  headline: 'A.',
  narrative: 'It does a thing, [here](ref:far).',
  files: ['src/a.js'],
  refs: [{ id: 'far', path: 'src/a.js', side: 'R', start: 500, end: 510 }],
  ...extra,
});
const planOf = (...chapters: PlanChapter[]): Plan => ({ mode: 'journey', chapters });

// ---------- A: a pointer on lines in no hunk is a problem for a chapter being written

test('a written chapter whose ref is on lines in no hunk is refused, and the line names it', () => {
  const problems = chapterProblems(planOf(chapter()), { diff });
  assert.deepEqual(problems, [
    'chapter 1: ref "far" (src/a.js:500-510) is on lines that are in no hunk',
  ]);
});

test('the same chapter, equal to the served one, is left alone; a changed one is checked again', () => {
  const served = planOf(chapter());
  assert.deepEqual(chapterProblems(planOf(chapter()), { diff, served }), []);
  const edited = planOf(chapter({ narrative: 'It does another thing, [here](ref:far).' }));
  assert.equal(chapterProblems(edited, { diff, served }).length, 1);
  assert.deepEqual(
    chapterProblems(planOf(chapter()), { diff, pointers: false }),
    [],
    'the story check reports pointers itself, so it asks for none here',
  );
});

test('a ref inside a hunk, or with no lines, is fine; with no diff to check against nothing is', () => {
  const inside = chapter({
    refs: [
      { id: 'far', path: 'src/a.js', side: 'R', start: 11, end: 12 },
      { id: 'file', path: 'src/a.js' },
    ],
  });
  assert.deepEqual(chapterProblems(planOf(inside), { diff }), []);
  assert.deepEqual(chapterProblems(planOf(chapter())), []);
});

test('a drafted comment on a line in no hunk is refused; a carried or unmapped one is not', () => {
  const commentOn = (extra: Record<string, unknown>) =>
    planOf(
      chapter({
        refs: [],
        narrative: 'Plain.',
        comments: [{ path: 'src/a.js', line: 99, body: 'Why?', ...extra }],
      }),
    );
  assert.deepEqual(chapterProblems(commentOn({}), { diff }), [
    'chapter 1: the comment on src/a.js:99 is on a line that is in no hunk',
  ]);
  assert.deepEqual(chapterProblems(commentOn({ carried: true }), { diff }), []);
  assert.deepEqual(chapterProblems(commentOn({ unmapped: true }), { diff }), []);
});

test("the overview's refs are pointers too, unless the overview is the served one", () => {
  const plan = (): Plan => ({
    ...planOf(chapter({ refs: [], narrative: 'Plain.' })),
    overview: 'The story, at [a place](ref:far).',
    refs: [{ id: 'far', path: 'src/a.js', side: 'R', start: 500, end: 510 }],
  });
  assert.deepEqual(chapterProblems(plan(), { diff }), [
    'the overview: ref "far" (src/a.js:500-510) is on lines that are in no hunk',
  ]);
  assert.deepEqual(chapterProblems(plan(), { diff, served: plan() }), []);
});

test('a fragment for a chapter with an off-page ref is refused with that line', () => {
  const skeleton = planOf(chapter({ narrative: undefined }));
  const { plan, outcomes } = mergeFragments(
    skeleton,
    [{ key: 'a', narrative: '### Chapter 1: A\n\nIt does a thing, [here](ref:far).' }],
    diff,
  );
  assert.equal(outcomes[0].status, 'rejected');
  assert.match(
    outcomes[0].why,
    /^ref "far" \(src\/a\.js:500-510\) is on lines that are in no hunk/,
  );
  assert.equal(plan.chapters![0].narrative, undefined);
});

// ---------- B: a ref counts when the chapter's text links it

// src/big.js has one hunk of 82 lines (new lines 10-91); src/other.js has one of 3 lines on a small file
const big = parseUnifiedDiff([...modified('src/big.js', [[10, 80]]), ''].join('\n'));
const bigChapter = (extra: Partial<PlanChapter> = {}): PlanChapter => ({
  key: 'big',
  title: 'Chapter 1: Big',
  headline: 'Big.',
  narrative: 'It reworks the thing, with no link.',
  files: ['src/big.js'],
  refs: [{ id: 'mid', path: 'src/big.js', side: 'R', start: 20, end: 40 }],
  ...extra,
});
const told = (chapter: PlanChapter, options = {}) =>
  uncoveredHunks(chaptersOf(planOf(chapter)), big, options);

test('a ref no text links covers nothing; linked, it covers its hunk', () => {
  assert.equal(told(bigChapter()).length, 0, 'counted as before when nobody asks for the link');
  assert.deepEqual(
    told(bigChapter(), { linked: true }).map((file) => file.hunks.map((hunk) => hunk.ref)),
    [['src/big.js:10-91']],
  );
  const linked = bigChapter({ narrative: 'It reworks [the middle](ref:mid) of the thing.' });
  assert.deepEqual(told(linked, { linked: true }), []);
  const inSummary = bigChapter({ summary: 'See [the middle](ref:mid).' });
  assert.deepEqual(told(inSummary, { linked: true }), [], 'any text of the chapter links');
});

test('a skeleton, a "Since you read it" chapter and a kept chapter count every ref', () => {
  assert.deepEqual(told(bigChapter({ narrative: '' }), { linked: true }), [], 'no text yet');
  const since = bigChapter({ since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 } });
  assert.deepEqual(told(since, { linked: true }), []);
  assert.deepEqual(told(bigChapter(), { linked: true, kept: [true] }), []);
  assert.equal(told(bigChapter(), { linked: true, kept: [false] }).length, 1);
});

test('a rebuild keeps a published chapter with an unlinked ref, and refuses a new one', () => {
  const before = planOf(bigChapter(), {
    ...bigChapter({ key: 'two', title: 'Chapter 2: Two', files: [], refs: [] }),
  });
  const after = structuredClone(before);
  after.chapters![1].narrative = 'Re-told.';
  const build = { mode: 'rebuild_from', from_step: 2 };
  assert.deepEqual(rebuildProblems(build, before, after, big), []);
  // a whole rebuild keeps a chapter it leaves as it was, and checks one it re-tells
  assert.deepEqual(rebuildProblems({ mode: 'rebuild' }, before, after, big), []);
  after.chapters![0].narrative = 'Re-told, still with no link.';
  const problems = rebuildProblems({ mode: 'rebuild' }, before, after, big);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hunks not covered: src\/big\.js:10-91 \(a ref counts when/);
});

// ---------- B: told thinly

const withLines = (rel: string, added: number) =>
  parseUnifiedDiff([...modified(rel, [[1, added]]), ''].join('\n'));
const wholeChapter = (rel: string): PlanChapter => ({
  key: 'w',
  title: 'Chapter 1: W',
  files: [{ rel, whole: true }],
  refs: [],
});

test('a file told whole warns past 300 changed lines, and not at 300', () => {
  const over = withLines('src/w.js', 301);
  assert.deepEqual(
    thinHunks(chaptersOf(planOf(wholeChapter('src/w.js'))), over).map((place) => [
      place.kind,
      place.lines,
    ]),
    [['whole', 301]],
  );
  const exact = withLines('src/w.js', 300);
  assert.deepEqual(thinHunks(chaptersOf(planOf(wholeChapter('src/w.js'))), exact), []);
});

test('a hunk of 60+ lines warns when the pointers cover under a tenth, two refs count together, a short hunk is exempt', () => {
  const refTo = (start: number, end: number, id = 'r') => ({
    id,
    path: 'src/big.js',
    side: 'R',
    start,
    end,
  });
  const thinOf = (refs: ReturnType<typeof refTo>[], link = true) =>
    thinHunks(
      chaptersOf(
        planOf(
          bigChapter({
            refs,
            narrative: link ? refs.map((ref) => `[x](ref:${ref.id})`).join(' ') : 'No link.',
          }),
        ),
      ),
      big,
      { linked: true },
    );
  const [thin] = thinOf([refTo(20, 20)]);
  assert.deepEqual(
    [thin.kind, thin.ref, thin.lines, thin.covered],
    ['hunk', 'src/big.js:10-91', 82, 1],
  );
  assert.equal(thinOf([refTo(20, 27)]).length, 1, '8 lines is under 8.2');
  assert.equal(thinOf([refTo(20, 28)]).length, 0, '9 lines is a tenth and more');
  assert.equal(
    thinOf([refTo(20, 23, 'a'), refTo(40, 44, 'b')]).length,
    0,
    'two refs, 9 lines together',
  );
  assert.equal(
    thinOf([refTo(20, 23, 'a'), refTo(22, 25, 'b')]).length,
    1,
    'overlap counts once: 6 lines',
  );
  assert.equal(
    thinOf([refTo(20, 20)], false).length,
    0,
    'a ref nothing links is no pointer: the hunk is uncovered instead',
  );
  const short = withLines('src/big.js', 50);
  const chapter = bigChapter({ refs: [refTo(20, 20)], narrative: '[x](ref:r)' });
  assert.deepEqual(thinHunks(chaptersOf(planOf(chapter)), short, { linked: true }), []);
});

test('the refs a chapter gets from "hunks" ids cover the hunk whole, so they are never thin', () => {
  const plan = planOf(bigChapter({ refs: [], narrative: 'See [it](ref:h1).' }));
  plan.chapters![0].hunks = ['h1'];
  expandHunks(plan, big);
  assert.deepEqual(thinHunks(chaptersOf(plan), big, { linked: true }), []);
  assert.deepEqual(told(plan.chapters![0], { linked: true }), []);
});

test('a hunk the chapter lists by id counts as linked, with no link in its text; a hand-written ref still needs one', () => {
  const listed = planOf(bigChapter({ refs: [], narrative: 'No link at all.' }));
  listed.chapters![0].hunks = ['h1'];
  expandHunks(listed, big);
  assert.deepEqual(uncoveredHunks(chaptersOf(listed), big, { linked: true }), []);
  assert.deepEqual(
    storyFindings(listed, big).filter((finding) => finding.check === 'hunks'),
    [],
  );
  // the flag is on the plan's ref, so it survives into the published chapter and a rebuild's vet
  assert.equal(chaptersOf(listed)[0].refs[0].hunk, true);
  const handWritten = planOf(bigChapter({ narrative: 'No link at all.' }));
  assert.equal(uncoveredHunks(chaptersOf(handWritten), big, { linked: true }).length, 1);
});

test('the story check leaves a kept chapter alone, and fails the same chapter when it is new', () => {
  const unlinked = planOf(bigChapter());
  const fail = (served?: Plan) =>
    storyFindings(unlinked, big, served).filter(
      (finding) => finding.check === 'hunks' && finding.level === 'fail',
    );
  assert.equal(fail().length, 1);
  assert.deepEqual(fail(structuredClone(unlinked)), [], 'equal to the served chapter');
  const changed = structuredClone(unlinked);
  changed.chapters![0].narrative = 'It was told differently.';
  assert.equal(fail(changed).length, 1, 'a chapter that differs from the served one is checked');
});

test("an older story's text-pointer entry is no listing, so it is never an unfinished partial", () => {
  const chapters = chaptersOf(
    planOf(
      chapter({ files: [{ rel: 'src/a.js', partial: false }], refs: [] }),
      chapter({
        key: 'b',
        title: 'Chapter 2: B',
        files: [{ rel: 'src/a.js', partial: true, note: 'pointed at', ref: true }],
        refs: [],
      }),
    ),
  );
  assert.deepEqual(unfinishedPartials(chapters, diff), []);
  const listed = chaptersOf(
    planOf(chapter({ files: [{ rel: 'src/a.js', partial: true, note: 'some' }], refs: [] })),
  );
  assert.deepEqual(unfinishedPartials(listed, diff), [{ rel: 'src/a.js', index: 0 }]);
});

test('the story check warns about a thin hunk and fails an unlinked one', () => {
  const thin = planOf(
    bigChapter({
      refs: [{ id: 'mid', path: 'src/big.js', side: 'R', start: 20, end: 20 }],
      narrative: 'See [the line](ref:mid).',
    }),
  );
  const found = storyFindings(thin, big).filter((finding) => finding.check === 'hunks');
  assert.deepEqual(
    found.map((finding) => [finding.level, finding.kind]),
    [['warn', 'thin-hunk']],
  );
  const unlinked = storyFindings(planOf(bigChapter()), big).filter(
    (finding) => finding.check === 'hunks',
  );
  assert.deepEqual(
    unlinked.map((finding) => finding.level),
    ['fail'],
  );
  assert.match(unlinked[0].message, /a ref counts when the chapter's text links it/);
});
