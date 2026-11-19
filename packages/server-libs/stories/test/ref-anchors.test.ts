import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import type { ChapterRef } from '@once-upon-a-diff/contracts/types';
import { chaptersOf, type Plan } from '../src/chapters.ts';
import { parseUnifiedDiff } from '../src/diff.ts';
import {
  anchorFor,
  anchorsFor,
  lineTextAt,
  markMovedLines,
  movedRefs,
  readAnchors,
  writeAnchors,
} from '../src/anchors.ts';

// one file, two hunks: new lines 1-6 (a replaced line, a context blank) and 20-22 (an added line); old 1-6 and 18-19
const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,5 +1,6 @@',
  ' import x from "x";',
  '-const old = 1;',
  '+const fresh = 2;',
  '+const more = 3;',
  ' ',
  ' export function go() {',
  ' }',
  '\\ No newline at end of file',
  '@@ -18,2 +20,3 @@',
  '   keep   me',
  '+  added line here',
  ' tail',
  '',
].join('\n');

const files = () => parseUnifiedDiff(DIFF);
const file = () => files().get('src/a.js')!;

test('lineTextAt reads both sides of a hunk, counting each line on the side it is on', () => {
  assert.equal(lineTextAt(file(), 'R', 1), 'import x from "x";');
  assert.equal(lineTextAt(file(), 'R', 2), 'const fresh = 2;');
  assert.equal(lineTextAt(file(), 'L', 2), 'const old = 1;');
  assert.equal(lineTextAt(file(), 'L', 3), '', 'a blank context line is on both sides');
  assert.equal(lineTextAt(file(), 'R', 4), '', 'the old line 3 is new line 4');
  assert.equal(lineTextAt(file(), 'R', 6), '}');
  assert.equal(lineTextAt(file(), 'L', 5), '}');
  assert.equal(lineTextAt(file(), 'R', 7), null, 'the no-newline mark counts on neither side');
  assert.equal(lineTextAt(file(), 'R', 20), 'keep me', 'whitespace is normalised');
  assert.equal(lineTextAt(file(), 'R', 21), 'added line here');
  assert.equal(lineTextAt(file(), 'L', 19), 'tail');
  assert.equal(lineTextAt(file(), 'R', 10), null, 'between hunks');
});

test('a removal-only hunk is read on the old side', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -4,2 +3,0 @@',
      '-gone one',
      '-gone two',
      '',
    ].join('\n'),
  );
  const only = diff.get('b.js')!;
  assert.equal(lineTextAt(only, 'L', 4), 'gone one');
  assert.equal(lineTextAt(only, 'L', 5), 'gone two');
  assert.equal(lineTextAt(only, 'R', 4), null);
  assert.deepEqual(anchorFor({ id: 'r', path: 'b.js', side: 'L', start: 4, end: 5 }, diff), {
    place: 'b.js@L:4-5',
    line: 4,
    text: 'gone one',
  });
});

test('anchorFor takes the first line with real text within the first 8, skipping blank, brace and no-hunk lines', () => {
  const diff = files();
  assert.deepEqual(anchorFor({ id: 'a', path: 'src/a.js', start: 4, end: 7 }, diff), {
    place: 'src/a.js@R:4-7',
    line: 5,
    text: 'export function go() {',
  });
  assert.equal(
    anchorFor({ id: 'a', path: 'src/a.js', start: 4, end: 4 }, diff),
    null,
    'a blank line',
  );
  assert.equal(anchorFor({ id: 'a', path: 'src/a.js', start: 6, end: 6 }, diff), null, 'a brace');
  // a range across the gap: the first lines are in no hunk and are skipped, but they count towards the 8
  assert.equal(anchorFor({ id: 'a', path: 'src/a.js', start: 15, end: 30 }, diff)?.line, 20);
  assert.equal(
    anchorFor({ id: 'a', path: 'src/a.js', start: 12, end: 30 }, diff),
    null,
    'no line within 8 of the start qualifies',
  );
  assert.equal(anchorFor({ id: 'a', path: 'src/a.js' }, diff), null, 'a whole file cannot drift');
  assert.equal(anchorFor({ id: 'a', path: 'src/nope.js', start: 1, end: 2 }, diff), null);
});

test('a renamed file is anchored by its new path', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/old.js b/new.js',
      'similarity index 80%',
      'rename from old.js',
      'rename to new.js',
      '--- a/old.js',
      '+++ b/new.js',
      '@@ -1,2 +1,2 @@',
      ' keep this line',
      '-before',
      '+after text',
      '',
    ].join('\n'),
  );
  assert.equal(anchorFor({ id: 'r', path: 'new.js', start: 2, end: 3 }, diff)?.text, 'after text');
  const bare = parseUnifiedDiff(
    [
      'diff --git a/x.js b/y.js',
      'similarity index 100%',
      'rename from x.js',
      'rename to y.js',
      '',
    ].join('\n'),
  );
  assert.equal(
    anchorFor({ id: 'r', path: 'y.js', start: 1, end: 2 }, bare),
    null,
    'no hunks, no lines',
  );
});

const plan = (chapters: Plan['chapters'], extra: Partial<Plan> = {}): Plan => ({
  chapters,
  ...extra,
});
const chapter = (key: string, refs: object[], narrative = 'text') => ({
  key,
  title: key,
  narrative,
  files: ['src/a.js'],
  refs,
});

test('anchorsFor records a told chapter, keeps a kept chapter’s entry, and records nothing for a kept one without one', () => {
  const diff = files();
  const refs = [
    { id: 'go', path: 'src/a.js', start: 5, end: 6 },
    { id: 'add', path: 'src/a.js', start: 21, end: 21 },
  ];
  const told = plan([chapter('one', refs)], {
    overview: 'o',
    refs: [{ id: 'top', path: 'src/a.js', start: 2, end: 2 }],
  });
  const first = anchorsFor(told, diff, null, null);
  assert.equal(first.chapters.one.go.text, 'export function go() {');
  assert.equal(first.chapters.one.add.text, 'added line here');
  assert.equal(first.overview.top.text, 'const fresh = 2;');

  // the same plan told again, over a changed diff: kept, so the old anchors stay
  const edited = parseUnifiedDiff(DIFF.replace('export function go()', 'export function went()'));
  assert.deepEqual(anchorsFor(told, edited, first, told), first);

  // a kept chapter with no earlier entry is not baselined from a diff that may have drifted
  const none = anchorsFor(told, edited, null, told);
  assert.deepEqual(none, { overview: {}, chapters: { one: {} } });

  // a retold chapter (text changed, same place) takes a fresh anchor from the diff as it is now
  const retold = plan([chapter('one', refs, 'new words')], { overview: 'o', refs: told.refs });
  const again = anchorsFor(retold, edited, first, told);
  assert.equal(again.chapters.one.go.text, 'export function went() {');
  assert.equal(
    again.overview.top.text,
    'const fresh = 2;',
    'the overview is kept: its entry stays',
  );

  // a chapter with a changed ref place is fresh too, and a new chapter is baselined
  const moved = plan([
    chapter('one', [{ id: 'go', path: 'src/a.js', start: 2, end: 6 }]),
    chapter('two', refs),
  ]);
  const next = anchorsFor(moved, diff, first, told);
  assert.equal(next.chapters.one.go.place, 'src/a.js@R:2-6');
  assert.equal(next.chapters.two.add.line, 21);
});

test('movedRefs flags an edited line, a shifted line and a line that left every hunk, and nothing else', () => {
  const anchors = anchorsFor(
    plan([
      chapter('one', [
        { id: 'go', path: 'src/a.js', start: 5, end: 6 },
        { id: 'add', path: 'src/a.js', start: 21, end: 21 },
        { id: 'file', path: 'src/a.js' },
      ]),
    ]),
    files(),
    null,
    null,
  );
  const check = (text: string) => {
    const diff = parseUnifiedDiff(text);
    const chapters = chaptersOf(
      plan([
        chapter('one', [
          { id: 'go', path: 'src/a.js', start: 5, end: 6 },
          { id: 'add', path: 'src/a.js', start: 21, end: 21 },
          { id: 'file', path: 'src/a.js' },
        ]),
      ]),
    );
    movedRefs(chapters, [], anchors, diff);
    return Object.fromEntries(chapters[0].refs.map((ref) => [ref.id, !!ref.moved]));
  };
  assert.deepEqual(check(DIFF), { go: false, add: false, file: false }, 'unchanged');
  assert.deepEqual(
    check(
      DIFF.replace(' export function go() {', ' export function  go()  {  ').replace(/\n/g, '\r\n'),
    ),
    { go: false, add: false, file: false },
    'whitespace and CRLF only',
  );
  assert.deepEqual(
    check(DIFF.replace(' export function go() {', ' export function fly() {')),
    { go: true, add: false, file: false },
    'the anchored line was edited',
  );
  assert.deepEqual(
    check(
      DIFF.replace('@@ -1,5 +1,6 @@', '@@ -1,5 +1,6 @@\n+inserted above').replace(
        '-18,2 +20,3',
        '-18,2 +21,3',
      ),
    ),
    { go: true, add: true, file: false },
    'lines were added above',
  );
  assert.deepEqual(
    check(DIFF.split('@@ -18,2')[0]),
    { go: false, add: true, file: false },
    'the second hunk is gone: its line is in no hunk',
  );
  assert.deepEqual(
    check(''),
    { go: false, add: false, file: false },
    'a file that left the diff is the filter’s business',
  );
});

test('movedRefs marks the file entry’s matching line span, the overview refs, and leaves another place unknown', () => {
  const refs = [{ id: 'go', path: 'src/a.js', start: 5, end: 6 }];
  const told = plan([chapter('one', refs)], {
    refs: [{ id: 'top', path: 'src/a.js', start: 2, end: 2 }],
  });
  const anchors = anchorsFor(told, files(), null, null);
  const edited = parseUnifiedDiff(
    DIFF.replace(' export function go() {', ' export function fly() {').replace(
      '+const fresh = 2;',
      '+const other = 2;',
    ),
  );
  const chapters = chaptersOf(told);
  const overview: ChapterRef[] = [{ id: 'top', path: 'src/a.js', side: 'R', start: 2, end: 2 }];
  movedRefs(chapters, overview, anchors, edited);
  assert.equal(chapters[0].refs[0].moved, true);
  assert.equal(chapters[0].files[0].lines?.[0].moved, true);
  assert.equal(overview[0].moved, true);

  // the author edited the ref since: the anchor is for another place, so it says nothing
  const changed = chaptersOf(
    plan([chapter('one', [{ id: 'go', path: 'src/a.js', start: 5, end: 7 }])]),
  );
  movedRefs(changed, [], anchors, edited);
  assert.equal(changed[0].refs[0].moved, undefined);
  assert.equal(changed[0].files[0].lines?.[0].moved, undefined);
});

test('markMovedLines marks only the span of the ref’s own file and side, and a ref with no side reads as R', () => {
  const told = chaptersOf(
    plan([
      {
        ...chapter('one', [
          { id: 'go', path: 'src/a.js', start: 5, end: 6 },
          { id: 'other', path: 'src/b.js', start: 5, end: 6 },
        ]),
        files: ['src/a.js', 'src/b.js'],
      },
    ]),
  )[0];
  const spans = (rel: string) => told.files.find((one) => one.rel === rel)?.lines;
  const spansA = spans('src/a.js')!;
  const spansB = spans('src/b.js')!;
  spansA.push(
    { side: 'L', start: 5, end: 6, label: '' },
    { side: 'R', start: 5, end: 7, label: '' },
  );
  assert.equal(spansA.length, 3);
  markMovedLines(told, { id: 'go', path: 'src/a.js', start: 5, end: 6 });
  assert.deepEqual(
    spansA.map((one) => !!one.moved),
    [true, false, false],
    'the R span of the same lines, not the L one or the longer one',
  );
  assert.deepEqual(
    spansB.map((one) => !!one.moved),
    [false],
    'another file is left alone',
  );
  markMovedLines(told, { id: 'go', path: 'src/a.js', side: 'L', start: 5, end: 6 });
  assert.equal(spansA[1].moved, true);
});

test('readAnchors of a missing or garbage file is null, and a written file reads back', () => {
  const dir = tmp('anchors');
  assert.equal(readAnchors(dir), null);
  const anchors = { overview: {}, chapters: { one: { go: { place: 'p', line: 1, text: 't' } } } };
  writeAnchors(dir, anchors);
  assert.deepEqual(readAnchors(dir), anchors);
  writeAnchors(dir, 'nope' as never);
  assert.equal(readAnchors(dir), null);
});
